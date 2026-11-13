package com.garlictransfer.core.source

import com.garlictransfer.core.DtException
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.UploadConfig
import com.garlictransfer.core.crypto.BODY_CHUNK_SIZE
import com.garlictransfer.core.crypto.CommandHeader
import com.garlictransfer.core.crypto.RECORD_MAX_SIZE
import com.garlictransfer.core.crypto.RecordLayer
import com.garlictransfer.core.crypto.SessionKeys
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.metadata.Metadata
import com.garlictransfer.core.metadata.SqlDbFactory
import com.garlictransfer.core.metadata.toJson
import com.garlictransfer.core.oracle.KeyDeriver
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.oracle.OracleDeriver
import com.garlictransfer.core.pair.Pairing
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leBuffer
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.recvExact
import com.garlictransfer.core.util.toHex
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val POWER_REQUEST_BODY_SIZE = 88
private const val ECHO_QUIRK_SIZE = 4_000_000L
private const val SESSION_TIMEOUT_MS = 310_000
private const val POWER_TIMEOUT_SECONDS = 310L

private val IPV4_REGEX = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""")

internal fun parseIpv4Bytes(text: String): ByteArray? {
    val match = IPV4_REGEX.matchEntire(text) ?: return null
    val out = ByteArray(4)
    for (i in 0 until 4) {
        val value = match.groupValues[i + 1].toIntOrNull() ?: return null
        if (value > 255) return null
        out[i] = value.toByte()
    }
    return out
}

internal fun parseIpv6Bytes(text: String): ByteArray? {
    var input = text
    if ('.' in input) {
        val idx = input.lastIndexOf(':')
        if (idx < 0) return null
        val v4 = parseIpv4Bytes(input.substring(idx + 1)) ?: return null
        input = input.substring(0, idx) + ":" + "%02x%02x:%02x%02x".format(
            v4[0].toInt() and 0xFF, v4[1].toInt() and 0xFF, v4[2].toInt() and 0xFF, v4[3].toInt() and 0xFF,
        )
    }
    val compression = input.indexOf("::")
    if (compression >= 0 && input.indexOf("::", compression + 2) >= 0) return null
    val head = if (compression >= 0) input.substring(0, compression) else input
    val tail = if (compression >= 0) input.substring(compression + 2) else ""
    val headGroups = if (head.isEmpty()) emptyList() else head.split(":")
    val tailGroups = if (tail.isEmpty()) emptyList() else tail.split(":")
    if (compression < 0 && headGroups.size != 8) return null
    val fill = 8 - headGroups.size - tailGroups.size
    if (compression >= 0 && fill < 1) return null
    fun groupValue(group: String): Int? {
        if (group.isEmpty() || group.length > 4) return null
        if (!group.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        return group.toInt(16)
    }
    val groups = ArrayList<Int>(8)
    for (group in headGroups) groups += groupValue(group) ?: return null
    repeat(fill) { groups += 0 }
    for (group in tailGroups) groups += groupValue(group) ?: return null
    if (groups.size != 8) return null
    val out = ByteArray(16)
    groups.forEachIndexed { i, value ->
        out[2 * i] = (value shr 8).toByte()
        out[2 * i + 1] = value.toByte()
    }
    return out
}

/** The 16-byte DDP host-address form of an IPv4 address. */
internal fun ipv4MappedBytes(ip: ByteArray): ByteArray {
    require(ip.size == 4)
    return ByteArray(10) + byteArrayOf(0xFF.toByte(), 0xFF.toByte()) + ip
}

/** Parses an IPv4 or IPv6 literal into the 16 bytes DDP expects (IPv4 in mapped form). */
internal fun packedDataAddress(text: String): ByteArray {
    if (':' in text) {
        return parseIpv6Bytes(text) ?: throw DtException("not a valid IP address: $text")
    }
    val v4 = parseIpv4Bytes(text) ?: throw DtException("not a valid IP address: $text")
    return ipv4MappedBytes(v4)
}

/**
 * Upload path: emulates a PS5 "source" console on this device (port of poc/dt_source.py).
 * Binds UDP [UploadConfig.discoveryPort] plus TCP command/data ports — the stock ports
 * (1004/1005/1006) are privileged, so on Android this needs root; the app surfaces that.
 */
class UploadServer(
    val config: UploadConfig,
    val dbFactory: SqlDbFactory,
    val listener: TransferListener? = null,
    val deriverOverride: com.garlictransfer.core.oracle.KeyDeriver? = null,
) : AutoCloseable {

    companion object {
        internal val FALLBACK_DATA_ADDRESS: ByteArray = "00000000000000000000ffffc0a8006f".hexToBytes()
    }

    @Volatile
    private var running = false

    @Volatile
    private var dataAddress: ByteArray = FALLBACK_DATA_ADDRESS.copyOf()

    @Volatile
    private var sawB3 = false

    @Volatile
    private var powerLatch = CountDownLatch(1)

    private val stateLock = Any()
    private val threads = CopyOnWriteArrayList<Thread>()
    private val sessions = ConcurrentHashMap.newKeySet<Socket>()
    private var discoverySocket: DatagramSocket? = null
    private var commandListener: ServerSocket? = null
    private var dataListener: ServerSocket? = null
    private val random = SecureRandom()

    val isRunning: Boolean
        get() = running

    /** Binds all sockets and spawns the server threads; returns immediately. */
    fun start() {
        synchronized(stateLock) {
            if (running) return
            config.advertiseAddress?.let { dataAddress = packedDataAddress(it) }
            val bind = config.bindAddress?.let { InetAddress.getByName(it) }
            try {
                val udp = DatagramSocket(null)
                udp.reuseAddress = true
                udp.bind(if (bind != null) InetSocketAddress(bind, config.discoveryPort) else InetSocketAddress(config.discoveryPort))
                val command = ServerSocket()
                command.reuseAddress = true
                command.bind(if (bind != null) InetSocketAddress(bind, config.commandPort) else InetSocketAddress(config.commandPort), 1)
                val data = ServerSocket()
                data.reuseAddress = true
                data.bind(if (bind != null) InetSocketAddress(bind, config.dataPort) else InetSocketAddress(config.dataPort), 1)
                discoverySocket = udp
                commandListener = command
                dataListener = data
                running = true
                spawn("gt-ddp") { discoveryLoop(udp) }
                spawn("gt-cmd-accept") { acceptLoop(command, "cmd") { socket -> serveCommand(socket) } }
                spawn("gt-data-accept") { acceptLoop(data, "data") { socket -> serveData(socket) } }
            } catch (e: Exception) {
                running = false
                runCatching { discoverySocket?.close() }
                runCatching { commandListener?.close() }
                runCatching { dataListener?.close() }
                discoverySocket = null
                commandListener = null
                dataListener = null
                if (e is DtException) throw e
                throw DtException("failed to bind the upload server ports: ${e.message}", e)
            }
            emit(TransferEvent.Status("upload", "source listening on port ${config.commandPort}; select ${config.hostName} on the PS5"))
        }
    }

    /** Releases the power-button wait (0x91) as if the console's power button was pressed. */
    fun signalPower() {
        synchronized(stateLock) { powerLatch }.countDown()
    }

    fun stop() {
        val toJoin: List<Thread>
        synchronized(stateLock) {
            if (!running && discoverySocket == null && commandListener == null && dataListener == null) return
            running = false
            runCatching { discoverySocket?.close() }
            runCatching { commandListener?.close() }
            runCatching { dataListener?.close() }
            discoverySocket = null
            commandListener = null
            dataListener = null
            powerLatch.countDown()
            for (session in sessions) runCatching { session.close() }
            sessions.clear()
            toJoin = threads.toList()
            threads.clear()
            for (thread in toJoin) thread.interrupt()
        }
        for (thread in toJoin) runCatching { thread.join(2000) }
    }

    override fun close(): Unit = stop()

    private fun emit(event: TransferEvent) {
        try {
            listener?.onEvent(event)
        } catch (_: Exception) {
        }
    }

    private fun log(message: String) = emit(TransferEvent.Log(message))

    private fun spawn(name: String, block: () -> Unit): Thread {
        val thread = Thread({
            try {
                block()
            } catch (e: Exception) {
                if (running) log("[dt] $name failed: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                threads.remove(Thread.currentThread())
            }
        }, name)
        thread.isDaemon = true
        threads += thread
        thread.start()
        return thread
    }

    private fun selectDeriver(socket: Socket): KeyDeriver {
        deriverOverride?.let { return it }
        val remote = (socket.remoteSocketAddress as? InetSocketAddress)?.address
        if (config.useLocalPsk || remote is Inet6Address) return LocalPskDeriver()
        return OracleDeriver(config.oracleHost, config.oraclePort)
    }

    // --- Discovery responder ---

    private fun discoveryLoop(socket: DatagramSocket) {
        val buffer = ByteArray(4096)
        while (running) {
            val packet = DatagramPacket(buffer, buffer.size)
            try {
                socket.receive(packet)
            } catch (e: Exception) {
                if (running && !socket.isClosed) continue else break
            }
            val verb = String(packet.data, packet.offset, packet.length, Charsets.US_ASCII).substringBefore(' ')
            log("[ddp] ${packet.address.hostAddress}: $verb")
            if (verb != "SRCH" && verb != "LAUNCH4") continue
            detectDataAddress(packet.address)
            val common = "HTTP/1.1 200 Ok\n" +
                "host-id:${config.hostId}\n" +
                "host-request-port:${config.commandPort}\n" +
                "device-discovery-protocol-version:00030010\n"
            val reply = if (verb == "SRCH") {
                common + "host-type:PS5\nhost-name:${config.hostName}\nsystem-version:${config.systemVersion}\n"
            } else {
                common + "host-network:0\nhost-address:${dataAddress.toHex()}\n"
            }
            try {
                val bytes = reply.toByteArray(Charsets.US_ASCII)
                socket.send(DatagramPacket(bytes, bytes.size, packet.address, packet.port))
            } catch (e: Exception) {
                if (!running || socket.isClosed) break
            }
        }
    }

    private fun detectDataAddress(peer: InetAddress) {
        if (config.advertiseAddress != null || peer !is Inet4Address) return
        val detected = try {
            DatagramSocket().use { probe ->
                probe.connect(peer, 9)
                probe.localAddress
            }
        } catch (e: Exception) {
            null
        }
        if (detected is Inet4Address && !detected.isAnyLocalAddress) {
            val mapped = ipv4MappedBytes(detected.address)
            if (!mapped.contentEquals(dataAddress)) {
                dataAddress = mapped
                log("[ddp] advertising data address ${detected.hostAddress} (route toward ${peer.hostAddress}), data port ${config.dataPort}")
            }
        }
    }

    // --- Shared channel plumbing ---

    private fun acceptLoop(server: ServerSocket, tag: String, handler: (Socket) -> Unit) {
        while (running) {
            val socket = try {
                server.accept()
            } catch (e: Exception) {
                break
            }
            log("[$tag] connection from ${socket.remoteSocketAddress}")
            sessions += socket
            spawn("gt-$tag-session") {
                try {
                    handler(socket)
                } finally {
                    sessions -= socket
                    runCatching { socket.close() }
                }
            }
        }
    }

    private fun sendResponse(
        records: RecordLayer,
        keys: SessionKeys,
        sendSequence: Long,
        header: CommandHeader,
        result: Long,
        body: ByteArray,
        declaredSize: Long = body.size.toLong(),
    ): Long {
        var sequence = sendSequence
        records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, CommandHeader(header.cmd, header.sub, header.version, result, declaredSize).pack())
        var offset = 0
        while (offset < body.size) {
            val end = minOf(offset + BODY_CHUNK_SIZE, body.size)
            records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, body.copyOfRange(offset, end))
            offset = end
        }
        return sequence
    }

    private fun recvBody(records: RecordLayer, keys: SessionKeys, startSequence: Long, size: Long): Pair<ByteArray, Long> {
        val out = ByteArrayOutputStream()
        var sequence = startSequence
        var remaining = size
        while (remaining > 0) {
            val chunk = records.recv(keys.recvKey, keys.recvNoncePrefix, sequence++)
            if (chunk.isEmpty()) throw DtException("empty body chunk")
            out.write(chunk)
            remaining -= chunk.size
        }
        return out.toByteArray() to sequence
    }

    private fun consoleInfo(hardware: Int, productCode: Int, npEnv: ByteArray, versionA: Int, versionB: Int): ByteArray {
        val body = ByteArray(72)
        System.arraycopy(config.hostId.hexToBytes().copyOf(6), 0, body, 0, 6)
        body[6] = 1
        val writer = leReader(body)
        writer.putInt(8, hardware)
        writer.putInt(12, productCode)
        writer.putShort(16, 1)
        writer.putShort(18, 1)
        System.arraycopy(npEnv, 0, body, 20, minOf(npEnv.size, 17))
        writer.putInt(32, versionA)
        writer.putInt(40, 1)
        writer.putInt(44, versionB)
        System.arraycopy(dataAddress, 0, body, 48, 16)
        return body
    }

    private fun cachePairingPrefix(body: ByteArray) {
        val destination = config.pairingPrefixPath ?: return
        if (body.size != POWER_REQUEST_BODY_SIZE) {
            throw DtException("cannot cache a pairing prefix from a malformed power request")
        }
        val expected = config.expectedHostId?.lowercase() ?: ""
        val observed = body.copyOfRange(32, 38).toHex()
        if (observed != expected) {
            throw DtException("power request console ID does not match the selected console")
        }
        Pairing.savePrefix(body.copyOf(32), File(destination))
        log("[pairing] cached console approval for future metadata downloads")
    }

    private fun awaitPower() {
        val latch = CountDownLatch(1)
        synchronized(stateLock) { powerLatch = latch }
        val delay = config.autoPowerDelayMs
        if (delay != null) {
            spawn("gt-auto-power") {
                Thread.sleep(delay)
                latch.countDown()
                log("[dt] power-button simulation signalled")
            }
        }
        emit(TransferEvent.PowerRequired("press the console power button briefly to enter Data Transfer mode"))
        log("[power] press the console power button")
        if (!latch.await(POWER_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw DtException("power-button simulation timed out")
        }
    }

    // --- Command channel ---

    private fun serveCommand(socket: Socket) {
        socket.soTimeout = SESSION_TIMEOUT_MS
        var reason = "session closed"
        try {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            val serverValue = ByteArray(16).also(random::nextBytes)
            output.write(serverValue + ByteArray(48))
            output.flush()
            val clientValue = recvExact(input, 64).copyOf(16)
            val keys = selectDeriver(socket).derive(clientValue, serverValue).swapped()
            val records = RecordLayer(input, output)
            val completion = records.recv(keys.recvKey, keys.recvNoncePrefix, 0)
            log("[cmd] completion: ${completion.toHex()}")
            var recvSequence = 1L
            var sendSequence = 0L
            while (running) {
                val header = CommandHeader.parse(records.recv(keys.recvKey, keys.recvNoncePrefix, recvSequence++))
                log("[cmd] cmd=0x%02x sub=%d version=0x%x body=%d".format(header.cmd, header.sub, header.version, header.bodySize))
                var body = ByteArray(0)
                if (header.bodySize != 0L && !(header.cmd == 0x92 && header.bodySize == ECHO_QUIRK_SIZE)) {
                    body = records.recv(keys.recvKey, keys.recvNoncePrefix, recvSequence++)
                }
                var result = 0L
                var responseBody = ByteArray(0)
                when (header.cmd) {
                    0x91, 0x93 -> {
                        if (body.size < POWER_REQUEST_BODY_SIZE) throw DtException("malformed power request: ${body.size} bytes")
                        val reader = leReader(body)
                        val hardware = reader.apply { position(44) }.int
                        val productCode = reader.apply { position(48) }.int
                        val npEnv = body.copyOfRange(56, 73)
                        val versionA = reader.apply { position(76) }.int
                        val versionB = reader.apply { position(84) }.int
                        responseBody = consoleInfo(hardware, productCode, npEnv, versionA, versionB)
                        if (header.cmd == 0x91) {
                            cachePairingPrefix(body)
                            sendSequence = sendResponse(records, keys, sendSequence, header, 33, ByteArray(0))
                            log("[cmd] response complete cmd=0x91 result=33")
                            awaitPower()
                        }
                    }
                    0x92 -> responseBody = body
                    0xA1, 0x94, 0xB0, 0xB1, 0xB3 -> Unit
                    else -> result = 2L
                }
                if (header.cmd == 0xB3) sawB3 = true
                sendSequence = sendResponse(records, keys, sendSequence, header, result, responseBody)
                if (header.cmd == 0xA1) {
                    records.send(keys.sendKey, keys.sendNoncePrefix, sendSequence++, leBuffer(4).putInt(1000).array())
                }
                log("[cmd] response complete cmd=0x%02x result=%d".format(header.cmd, result))
                if (header.cmd == 0x92 || header.cmd !in listOf(0x91, 0x93, 0xA1, 0xB3)) {
                    reason = "cmd=0x%02x".format(header.cmd)
                    break
                }
            }
        } catch (e: Exception) {
            reason = e.message ?: e.javaClass.simpleName
        } finally {
            log("[cmd] session ended: $reason")
            if (sawB3) {
                sawB3 = false
                emit(TransferEvent.Done("console closed the transfer session"))
            }
        }
    }

    // --- Data channel ---

    private fun serveData(socket: Socket) {
        socket.soTimeout = SESSION_TIMEOUT_MS
        var reason = "session closed"
        try {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            val clientValue = recvExact(input, 64).copyOf(16)
            val serverValue = ByteArray(16).also(random::nextBytes)
            output.write(serverValue + ByteArray(48))
            output.flush()
            val keys = selectDeriver(socket).derive(clientValue, serverValue).swapped()
            val records = RecordLayer(input, output)
            val completion = records.recv(keys.recvKey, keys.recvNoncePrefix, 0)
            log("[data] completion: ${completion.toHex()}")
            var recvSequence = 1L
            var sendSequence = 0L
            while (running) {
                val header = CommandHeader.parse(records.recv(keys.recvKey, keys.recvNoncePrefix, recvSequence++))
                log("[data] cmd=0x%02x sub=%d version=0x%x body=%d".format(header.cmd, header.sub, header.version, header.bodySize))
                if (header.cmd == 0x92) {
                    sendSequence = sendResponse(records, keys, sendSequence, header, 0, ByteArray(0), declaredSize = header.bodySize)
                    var remaining = header.bodySize
                    while (remaining > 0) {
                        val chunk = records.recv(keys.recvKey, keys.recvNoncePrefix, recvSequence++)
                        records.send(keys.sendKey, keys.sendNoncePrefix, sendSequence++, chunk)
                        remaining -= chunk.size
                    }
                    log("[data] response complete cmd=0x92 result=0")
                    reason = "cmd=0x92"
                    break
                }
                var body = ByteArray(0)
                if (header.bodySize != 0L) {
                    val accumulated = recvBody(records, keys, recvSequence, header.bodySize)
                    body = accumulated.first
                    recvSequence = accumulated.second
                }
                var result = 0L
                var responded = true
                var endAfter = false
                when (header.cmd) {
                    0xA0 -> {
                        for (step in 0..6) {
                            records.send(
                                keys.sendKey, keys.sendNoncePrefix, sendSequence++,
                                CommandHeader(header.cmd, header.sub, header.version, if (step < 6) 0x23L else 0L, 0).pack(),
                            )
                        }
                    }
                    0xB2 -> sendSequence = serveEntryFiles(records, keys, sendSequence, header, body)
                    0xB4 -> sendSequence = serveRegistryRead(records, keys, sendSequence, header, body)
                    0xB5 -> sendSequence = serveUserRegistry(records, keys, sendSequence, header, body)
                    0xB1 -> sendSequence = sendResponse(records, keys, sendSequence, header, 0, ByteArray(0))
                    0xB3 -> {
                        sawB3 = true
                        sendSequence = sendResponse(records, keys, sendSequence, header, 0, ByteArray(0))
                        endAfter = true
                    }
                    else -> responded = false
                }
                if (!responded) {
                    reason = "unknown cmd=0x%02x".format(header.cmd)
                    break
                }
                log("[data] response complete cmd=0x%02x result=%d".format(header.cmd, result))
                if (endAfter) {
                    reason = "cmd=0xb3"
                    break
                }
            }
        } catch (e: Exception) {
            reason = e.message ?: e.javaClass.simpleName
        } finally {
            log("[data] session ended: $reason")
        }
    }

    private fun serveEntryFiles(records: RecordLayer, keys: SessionKeys, sendSequence: Long, header: CommandHeader, body: ByteArray): Long {
        if (body.size < 8) throw DtException("malformed 0xb2 request")
        val reader = leReader(body)
        val fileType = reader.int.toLong() and 0xFFFFFFFFL
        val fileId = reader.apply { position(4) }.int.toLong() and 0xFFFFFFFFL
        var sequence = sendSequence
        if (fileType == 1L) {
            val metadata = File(config.metadataPath).readBytes()
            sequence = sendResponse(records, keys, sequence, header, 0, metadata)
        } else {
            sequence = sendResponse(records, keys, sequence, header, 0, ByteArray(0))
            sequence = sendSaveChunks(records, keys, sequence, fileType, fileId)
        }
        return sequence
    }

    private fun resolvePayload(assets: File, entryId: Long, name: String): File {
        val inEntry = File(assets, "$entryId/$name")
        if (inEntry.isFile) return inEntry
        val inRoot = File(assets, name)
        return if (inRoot.isFile) inRoot else inEntry
    }

    private fun sendSaveChunks(records: RecordLayer, keys: SessionKeys, sendSequence: Long, fileType: Long, fileId: Long): Long {
        val assets = File(config.assetsPath)
        var sequence = sendSequence
        val manifestExists = File(config.manifestPath).isFile ||
            File(assets, "manifest.json").isFile ||
            File(assets, "$fileId/manifest.json").isFile
        val loaded = if (!manifestExists) {
            null
        } else {
            try {
                Metadata.loadManifest(assets, fileId)
            } catch (e: Exception) {
                log("[data] GFP5 id=$fileId manifest unusable: ${e.message ?: e.javaClass.simpleName}")
                null
            }
        }
        var finalHeader: ByteArray
        val resolved = if (loaded != null && (fileType == 2L || fileType == 3L)) {
            loaded.second.files.map { it to resolvePayload(assets, loaded.first, it.file) }
        } else {
            emptyList()
        }
        if (loaded != null && resolved.isNotEmpty() && resolved.all { it.second.isFile }) {
            val (entryId, manifest) = loaded
            dbFactory.open(File(config.metadataPath)).use { db ->
                if (config.uploadKind == "other") {
                    Metadata.syncOtherMetadata(db, entryId, manifest.files)
                } else {
                    Metadata.syncUploadMetadata(db, entryId, Metadata.inferTitleId(manifest.files.map { it.path }), manifest.files)
                }
            }
            File(config.manifestPath).writeText(manifest.toJson())
            for ((item, file) in resolved) {
                log("[data] GFP5 id=$entryId type=$fileType path=${item.path} size=${item.size}")
                records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, item.header.hexToBytes())
                if (fileType == 2L) {
                    var sent = 0L
                    file.inputStream().use { stream ->
                        val buffer = ByteArray(BODY_CHUNK_SIZE)
                        while (true) {
                            val count = stream.read(buffer)
                            if (count < 0) break
                            records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, buffer.copyOf(count))
                            sent += count
                        }
                    }
                    log("[data] GFP5 file complete id=$entryId bytes=$sent")
                }
            }
            finalHeader = manifest.finalHeader.hexToBytes()
        } else {
            log("[data] GFP5 id=$fileId type=$fileType noent")
            finalHeader = Gfp5.finalHeader(fileId)
        }
        records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, finalHeader)
        log("[data] GFP5 final header id=$fileId bytes=${finalHeader.size}")
        return sequence
    }

    private fun serveRegistryRead(records: RecordLayer, keys: SessionKeys, sendSequence: Long, header: CommandHeader, body: ByteArray): Long {
        if (body.size < 16) throw DtException("malformed 0xb4 request")
        val reader = leReader(body)
        val key = reader.int.toLong() and 0xFFFFFFFFL
        val valueSize = reader.apply { position(8) }.long
        if (valueSize < 0 || valueSize > RECORD_MAX_SIZE) throw DtException("malformed 0xb4 value size")
        val value = if (key == 0x02020000L) leBuffer(4).putInt(1).array() else ByteArray(valueSize.toInt())
        log("[data] GRP5 key=0x${key.toString(16)} size=$valueSize")
        var sequence = sendResponse(records, keys, sendSequence, header, 0, ByteArray(0))
        // body[4] is a single byte repacked as u64, matching the PoC descriptor layout.
        val descriptor = leBuffer(4).putInt(0x35505247).array() +
            body.copyOfRange(0, 4) +
            leBuffer(8).putLong(body[4].toLong() and 0xFFL).array() +
            body.copyOfRange(8, 16)
        records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, descriptor)
        records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, value)
        return sequence
    }

    private fun serveUserRegistry(records: RecordLayer, keys: SessionKeys, sendSequence: Long, header: CommandHeader, body: ByteArray): Long {
        if (body.size < 24) throw DtException("malformed 0xb5 request")
        val reader = leReader(body)
        val userId = reader.int.toLong() and 0xFFFFFFFFL
        val key = reader.int.toLong() and 0xFFFFFFFFL
        val valueType = reader.int.toLong() and 0xFFFFFFFFL
        reader.int
        val size = reader.long
        if (size < 0 || size > RECORD_MAX_SIZE) throw DtException("malformed 0xb5 value size")
        var value = ByteArray(0)
        if (key == 0x101L && valueType == 1L) {
            dbFactory.open(File(config.metadataPath)).use { db ->
                val login = db.queryOne("SELECT login_id FROM user_info_tbl WHERE user_id = ?", userId) { it.getString(0) }
                if (!login.isNullOrEmpty()) value = (login + "\u0000").toByteArray(Charsets.UTF_8)
            }
        }
        if (value.isEmpty()) {
            log("[data] no registry value for user=0x${userId.toString(16)} key=0x${key.toString(16)} type=$valueType")
        }
        value = value.copyOf(size.toInt())
        var sequence = sendResponse(records, keys, sendSequence, header, 0, ByteArray(0))
        val descriptor = leBuffer(4).putInt(0x35525547).array() + body.copyOfRange(0, 12) + body.copyOfRange(16, 24)
        records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, descriptor)
        records.send(keys.sendKey, keys.sendNoncePrefix, sequence++, value)
        return sequence
    }
}

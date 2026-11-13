package com.garlictransfer.core.pair

import com.garlictransfer.core.DtException
import com.garlictransfer.core.PairingOptions
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.crypto.CommandHeader
import com.garlictransfer.core.crypto.RecordLayer
import com.garlictransfer.core.oracle.KeyDeriver
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.recvExact
import com.garlictransfer.core.util.toHex
import java.io.File
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom

/**
 * One-time pairing listener (port of poc/dt_pair.py): captures the console's 0x91 power
 * request and keeps its first 32 bytes for future approvals. Never sends an encrypted
 * response and never opens the data port.
 */
object Pairing {
    const val PREFIX_SIZE = 32
    const val POWER_BODY_SIZE = 88

    private const val HOST_ID = "020000000001"
    private const val HOST_NAME = "GarlicTransfer Pairing"
    private val HOST_ID_REGEX = Regex("[0-9a-fA-F]{12}")
    private val VERSION_REGEX = Regex("[0-9a-fA-F]{8}")
    private val IPV4_REGEX = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""")
    private val random = SecureRandom()

    /** Runs the listener until pairing completes or the deadline passes; returns the prefix file. */
    fun pair(options: PairingOptions, deriver: KeyDeriver, listener: TransferListener? = null): File {
        val ps5 = parseIpv4(options.ps5Ip) ?: throw DtException("ps5Ip must be an IPv4 address from discovery")
        validate(options)
        val bindIp = options.bindIp ?: localIpv4For(options.ps5Ip)
        val deadlineNs = System.nanoTime() + options.durationSec.toLong() * 1_000_000_000L
        val discovery = DatagramSocket(null)
        val server = ServerSocket()
        try {
            discovery.bind(InetSocketAddress("0.0.0.0", options.discoveryPort))
            server.reuseAddress = true
            server.bind(InetSocketAddress(bindIp, options.commandPort), 1)
            val discoveryThread = Thread({ discoveryLoop(discovery, bindIp, options, ps5, deadlineNs) }, "gt-pair-ddp")
            discoveryThread.isDaemon = true
            discoveryThread.start()
            try {
                emit(listener, TransferEvent.Status("pairing", "Pairing listener ready. Select $HOST_NAME on the PS5."))
                val dest = File(options.prefixPath)
                while (true) {
                    val remainingMs = (deadlineNs - System.nanoTime()) / 1_000_000L
                    if (remainingMs <= 0) throw DtException("pairing timed out")
                    server.soTimeout = remainingMs.coerceIn(1L, 500L).toInt()
                    val client = try {
                        server.accept()
                    } catch (e: SocketTimeoutException) {
                        continue
                    }
                    val fromConsole = (client.inetAddress as? Inet4Address)?.address?.contentEquals(ps5) == true
                    if (!fromConsole) {
                        runCatching { client.close() }
                        continue
                    }
                    try {
                        emit(listener, TransferEvent.Status("pairing", "PS5 connected; reading its Data Transfer request."))
                        val (prefix, observedHostId) = receivePrefix(client, deriver, deadlineNs)
                        if (!observedHostId.contentEquals(options.hostId.lowercase().hexToBytes())) {
                            throw DtException("Data Transfer request did not match the selected console")
                        }
                        savePrefix(prefix, dest)
                    } finally {
                        runCatching { client.close() }
                    }
                    emit(listener, TransferEvent.Done("paired"))
                    return dest
                }
            } finally {
                runCatching { discovery.close() }
                discoveryThread.join(2000)
            }
        } catch (e: SocketTimeoutException) {
            val timeout = DtException("pairing timed out")
            emit(listener, TransferEvent.Error(genericError(timeout)))
            throw timeout
        } catch (e: DtException) {
            emit(listener, TransferEvent.Error(genericError(e)))
            throw e
        } catch (e: Exception) {
            val wrapped = DtException(genericError(null), e)
            emit(listener, TransferEvent.Error(genericError(null)))
            throw wrapped
        } finally {
            runCatching { discovery.close() }
            runCatching { server.close() }
        }
    }

    /** Atomic, 0600 write of the 32-byte prefix. */
    fun savePrefix(prefix: ByteArray, dest: File) {
        if (prefix.size != PREFIX_SIZE) throw DtException("pairing prefix must contain 32 bytes")
        val target = dest.absoluteFile
        val parent = target.parentFile ?: throw DtException("prefixPath must be an absolute private file path")
        val missing = generateSequence(parent) { it.parentFile }.takeWhile { !it.exists() }.toList()
        for (directory in missing.asReversed()) {
            if (!directory.mkdir() && !directory.isDirectory) {
                throw DtException("cannot create the pairing directory")
            }
            setPosix(directory, "rwx------")
        }
        val temporary = File.createTempFile(".pairing-", null, parent)
        try {
            temporary.writeBytes(prefix)
            setPosix(temporary, "rw-------")
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            setPosix(target, "rw-------")
        } finally {
            temporary.delete()
        }
    }

    private fun genericError(cause: DtException?): String =
        "Pairing stopped (${cause?.message ?: "network error"}). Check the PS5, network, and oracle."

    private fun emit(listener: TransferListener?, event: TransferEvent) {
        try {
            listener?.onEvent(event)
        } catch (_: Exception) {
        }
    }

    private fun validate(options: PairingOptions) {
        if (!HOST_ID_REGEX.matches(options.hostId)) throw DtException("hostId must be 12 hexadecimal digits from discovery")
        if (!VERSION_REGEX.matches(options.systemVersion)) throw DtException("systemVersion must be eight hexadecimal digits from discovery")
        if (options.oracleHost.isBlank() || options.oraclePort !in 1..65535) throw DtException("invalid oracle address or port")
        if (options.prefixPath.isEmpty() || !File(options.prefixPath).isAbsolute) throw DtException("prefixPath must be an absolute private file path")
        if (options.durationSec !in 1..600) throw DtException("duration must be between 1 and 600 seconds")
    }

    private fun parseIpv4(text: String): ByteArray? {
        val match = IPV4_REGEX.matchEntire(text) ?: return null
        val out = ByteArray(4)
        for (i in 0 until 4) {
            val value = match.groupValues[i + 1].toIntOrNull() ?: return null
            if (value > 255) return null
            out[i] = value.toByte()
        }
        return out
    }

    private fun localIpv4For(ps5Ip: String): String {
        try {
            DatagramSocket().use { probe ->
                probe.connect(InetAddress.getByName(ps5Ip), 9)
                val address = probe.localAddress
                if (address is Inet4Address && !address.isAnyLocalAddress) return address.hostAddress
            }
        } catch (e: Exception) {
        }
        throw DtException("no local IPv4 route to the selected PS5")
    }

    internal fun discoveryReply(verb: String, bindIp: String, systemVersion: String, commandPort: Int): ByteArray? {
        val common = "HTTP/1.1 200 Ok\n" +
            "host-id:$HOST_ID\n" +
            "host-request-port:$commandPort\n" +
            "device-discovery-protocol-version:00030010\n"
        return when (verb) {
            "SRCH" -> (common + "host-type:PS5\nhost-name:$HOST_NAME\nsystem-version:$systemVersion\n").toByteArray(Charsets.US_ASCII)
            "LAUNCH4" -> {
                val v4 = parseIpv4(bindIp) ?: return null
                (common + "host-network:0\nhost-address:${ipv4Mapped(v4).toHex()}\n").toByteArray(Charsets.US_ASCII)
            }
            else -> null
        }
    }

    private fun ipv4Mapped(ip: ByteArray): ByteArray = ByteArray(10) + byteArrayOf(0xFF.toByte(), 0xFF.toByte()) + ip

    private fun discoveryLoop(socket: DatagramSocket, bindIp: String, options: PairingOptions, ps5: ByteArray, deadlineNs: Long) {
        socket.soTimeout = 500
        val buffer = ByteArray(4096)
        while (System.nanoTime() < deadlineNs && !socket.isClosed) {
            val packet = DatagramPacket(buffer, buffer.size)
            try {
                socket.receive(packet)
            } catch (e: Exception) {
                if (socket.isClosed) return else continue
            }
            val fromConsole = (packet.address as? Inet4Address)?.address?.contentEquals(ps5) == true
            if (!fromConsole) continue
            val verb = String(packet.data, packet.offset, packet.length, Charsets.US_ASCII).substringBefore(' ')
            val reply = discoveryReply(verb, bindIp, options.systemVersion.uppercase(), options.commandPort) ?: continue
            try {
                socket.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
            } catch (e: Exception) {
                if (socket.isClosed) return
            }
        }
    }

    /** Reads and validates one encrypted 0x91 request; sends no encrypted response. */
    private fun receivePrefix(socket: Socket, deriver: KeyDeriver, deadlineNs: Long): Pair<ByteArray, ByteArray> {
        refreshTimeout(socket, deadlineNs)
        val input = socket.getInputStream()
        val output = socket.getOutputStream()
        val serverValue = ByteArray(16).also(random::nextBytes)
        output.write(serverValue + ByteArray(48))
        output.flush()
        val clientValue = recvExact(input, 64).copyOf(16)
        val keys = deriver.derive(clientValue, serverValue).swapped()
        val records = RecordLayer(input, output)
        refreshTimeout(socket, deadlineNs)
        if (records.recv(keys.recvKey, keys.recvNoncePrefix, 0).isNotEmpty()) {
            throw DtException("unexpected handshake completion")
        }
        refreshTimeout(socket, deadlineNs)
        val headerBytes = records.recv(keys.recvKey, keys.recvNoncePrefix, 1)
        if (headerBytes.size != CommandHeader.SIZE) throw DtException("unexpected command header length")
        val header = CommandHeader.parse(headerBytes)
        if (header.cmd != 0x91 || header.bodySize != POWER_BODY_SIZE.toLong()) {
            throw DtException("expected an 88-byte Data Transfer power request")
        }
        val body = ByteArray(POWER_BODY_SIZE)
        var received = 0
        var sequence = 2L
        while (received < POWER_BODY_SIZE) {
            if (System.nanoTime() >= deadlineNs) throw DtException("pairing timed out")
            refreshTimeout(socket, deadlineNs)
            val chunk = records.recv(keys.recvKey, keys.recvNoncePrefix, sequence++)
            if (chunk.isEmpty() || received + chunk.size > POWER_BODY_SIZE) {
                throw DtException("invalid Data Transfer request length")
            }
            System.arraycopy(chunk, 0, body, received, chunk.size)
            received += chunk.size
        }
        return body.copyOf(PREFIX_SIZE) to body.copyOfRange(PREFIX_SIZE, 38)
    }

    private fun refreshTimeout(socket: Socket, deadlineNs: Long) {
        val remainingMs = (deadlineNs - System.nanoTime()) / 1_000_000L
        if (remainingMs <= 0) throw SocketTimeoutException("pairing timed out")
        socket.soTimeout = remainingMs.coerceAtMost(30_000L).toInt()
    }

    private fun setPosix(file: File, permissions: String) {
        try {
            Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString(permissions))
        } catch (_: Exception) {
        }
    }
}

package com.garlictransfer.core.channel

import com.garlictransfer.core.DtException
import com.garlictransfer.core.crypto.BODY_CHUNK_SIZE
import com.garlictransfer.core.crypto.CommandHeader
import com.garlictransfer.core.crypto.RecordLayer
import com.garlictransfer.core.crypto.SessionKeys
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.recvExact
import com.garlictransfer.core.util.toHex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private fun bindLoopbackTcp(): ServerSocket {
    var lastFailure: Exception? = null
    for (port in 39100..39900) {
        try {
            val server = ServerSocket()
            server.soTimeout = 15000
            server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            return server
        } catch (failure: Exception) {
            lastFailure = failure
        }
    }
    throw IllegalStateException("no loopback TCP port available", lastFailure)
}

private class FakeConsole(private val script: ServerSide.() -> Unit) {
    @Volatile
    private var failure: Throwable? = null

    @Volatile
    var port: Int = -1
        private set

    @Volatile
    lateinit var side: ServerSide

    private val ready = CountDownLatch(1)
    private val thread = Thread({ run() }, "fake-console").apply { isDaemon = true }

    fun start(): FakeConsole {
        thread.start()
        check(ready.await(15, TimeUnit.SECONDS)) { "fake console did not start" }
        failure?.let { throw IllegalStateException("fake console failed to start", it) }
        return this
    }

    fun join(expectFailure: Boolean = false) {
        thread.join(20000)
        if (thread.isAlive) throw AssertionError("fake console did not finish")
        if (!expectFailure) failure?.let { throw AssertionError("fake console failed", it) }
    }

    private fun run() {
        try {
            bindLoopbackTcp().use { server ->
                port = server.localPort
                ready.countDown()
                server.accept().use { socket ->
                    socket.soTimeout = 15000
                    val output = socket.getOutputStream()
                    val input = socket.getInputStream()
                    val serverValue = ByteArray(16) { (0xA0 + it).toByte() }
                    output.write(serverValue + ByteArray(48))
                    output.flush()
                    val clientValue = recvExact(input, 64).copyOf(16)
                    val keys = LocalPskDeriver().derive(clientValue, serverValue).swapped()
                    val layer = RecordLayer(input, output)
                    val completion = layer.recv(keys.recvKey, keys.recvNoncePrefix, 0)
                    check(completion.isEmpty()) { "handshake completion record must be empty" }
                    val serverSide = ServerSide(layer, keys)
                    side = serverSide
                    serverSide.script()
                }
            }
        } catch (problem: Throwable) {
            failure = problem
        } finally {
            ready.countDown()
        }
    }
}

private class ServerSide(private val layer: RecordLayer, private val keys: SessionKeys) {
    var recvSequence = 1L
    var sendSequence = 0L
    val commands = mutableListOf<Pair<CommandHeader, ByteArray>>()

    fun sendRecord(data: ByteArray) {
        layer.send(keys.sendKey, keys.sendNoncePrefix, sendSequence, data)
        sendSequence++
    }

    fun recvRecord(): ByteArray {
        val data = layer.recv(keys.recvKey, keys.recvNoncePrefix, recvSequence)
        recvSequence++
        return data
    }

    fun recvCommand(): CommandHeader {
        val header = CommandHeader.parse(recvRecord())
        val body = ByteArrayOutputStream()
        while (body.size().toLong() < header.bodySize) {
            val chunk = recvRecord()
            check(chunk.size.toLong() <= header.bodySize - body.size()) { "client body overshoot" }
            body.write(chunk)
        }
        commands.add(header to body.toByteArray())
        return header
    }

    fun sendResponse(cmd: Int, sub: Int, result: Long, body: ByteArray = ByteArray(0)) {
        sendRecord(CommandHeader(cmd, sub, 0x130, result, body.size.toLong()).pack())
        var offset = 0
        while (offset < body.size) {
            val end = minOf(offset + BODY_CHUNK_SIZE, body.size)
            sendRecord(body.copyOfRange(offset, end))
            offset = end
        }
    }
}

@Timeout(30)
class ChannelDownloadTest {

    private fun sha256(data: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(data).toHex()

    private fun connectChannel(port: Int): DtChannel =
        DtChannel("127.0.0.1", port, LocalPskDeriver(), connectTimeoutMs = 5000, ioTimeoutMs = 15000).apply { connect() }

    @Test
    fun `downloadMetadata waits out busy results and writes metadata db`(@TempDir tempDir: File) {
        val metadata = ByteArray(256) { it.toByte() }
        val console = FakeConsole {
            val prepare = recvCommand()
            check(prepare.cmd == 0xA0) { "expected A0, got ${prepare.cmd}" }
            sendResponse(0xA0, prepare.sub, 0x23)
            sendResponse(0xA0, prepare.sub, 0x23)
            sendResponse(0xA0, prepare.sub, 0)
            val transfer = recvCommand()
            check(transfer.cmd == 0xB2) { "expected B2, got ${transfer.cmd}" }
            sendResponse(0xB2, transfer.sub, 0, metadata)
        }.start()
        connectChannel(console.port).use { channel ->
            val statuses = mutableListOf<String>()
            val written = Downloads.downloadMetadata(channel, tempDir) { statuses.add(it) }
            assertArrayEquals(metadata, written.readBytes())
            assertEquals(File(tempDir, "metadata.db"), written)
            assertTrue(statuses.isNotEmpty())
        }
        console.join()
        val commands = console.side.commands
        assertEquals(2, commands.size)
        assertEquals(11L, leReader(commands[0].second).long)
        val transferBody = leReader(commands[1].second)
        assertEquals(1, transferBody.int)
        assertEquals(1, transferBody.int)
    }

    @Test
    fun `downloadMetadata rejects unexpected a0 results`(@TempDir tempDir: File) {
        val console = FakeConsole {
            val prepare = recvCommand()
            sendResponse(0xA0, prepare.sub, 0x11)
        }.start()
        connectChannel(console.port).use { channel ->
            val error = assertThrows<DtException> { Downloads.downloadMetadata(channel, tempDir) }
            assertTrue(error.message!!.contains("0x11"))
        }
        console.join()
    }

    @Test
    fun `downloadMetadata has a finite busy deadline`(@TempDir tempDir: File) {
        Downloads.prepareDeadlineMs = 600
        try {
            val console = FakeConsole {
                val prepare = recvCommand()
                var broken = false
                repeat(50) {
                    if (!broken) {
                        try {
                            sendResponse(0xA0, prepare.sub, 0x23)
                        } catch (ignored: Exception) {
                            broken = true
                        }
                    }
                }
            }.start()
            connectChannel(console.port).use { channel ->
                val error = assertThrows<DtException> { Downloads.downloadMetadata(channel, tempDir) }
                assertTrue(error.message!!.contains("did not complete"))
            }
            console.join(expectFailure = true)
        } finally {
            Downloads.prepareDeadlineMs = 120_000
        }
    }

    @Test
    fun `downloadEntry streams gfp5 files and writes the manifest`(@TempDir tempDir: File) {
        val entryId = 296L
        val pkgPayload = "pkg-data".toByteArray()
        val binPayload = "json".toByteArray()
        val pkgHeader = Gfp5.build(entryId, pkgPayload.size.toLong(), "/user/app/PPSA05688/app.pkg")
        val binHeader = Gfp5.build(entryId, binPayload.size.toLong(), "/user/app/PPSA05688/app.bin")
        val finalHeader = Gfp5.finalHeader(entryId)
        val console = FakeConsole {
            val transfer = recvCommand()
            check(transfer.cmd == 0xB2) { "expected B2, got ${transfer.cmd}" }
            sendResponse(0xB2, transfer.sub, 0)
            sendRecord(pkgHeader)
            sendRecord(pkgPayload + ByteArray(5))
            sendRecord(binHeader)
            sendRecord(binPayload)
            sendRecord(finalHeader)
        }.start()
        connectChannel(console.port).use { channel ->
            val manifestFile = Downloads.downloadEntry(channel, entryId, tempDir, packageOnly = false)
            val entryDir = File(tempDir, "296")
            assertArrayEquals(pkgPayload, File(entryDir, "app.pkg").readBytes())
            assertArrayEquals(binPayload, File(entryDir, "app.bin").readBytes())
            assertFalse(File(entryDir, "app.pkg.part").exists())
            assertFalse(File(entryDir, "app.bin.part").exists())

            val manifest = Json.parseToJsonElement(manifestFile.readText()).jsonObject
            assertEquals(entryId, manifest.getValue("entry_id").jsonPrimitive.long)
            assertEquals(2, manifest.getValue("files").jsonArray.size)
            val entry = manifest.getValue("296").jsonObject
            assertEquals(finalHeader.toHex(), entry.getValue("final_header").jsonPrimitive.content)
            val files = entry.getValue("files").jsonArray
            assertEquals(2, files.size)
            val pkg = files[0].jsonObject
            assertEquals("/user/app/PPSA05688/app.pkg", pkg.getValue("path").jsonPrimitive.content)
            assertEquals("app.pkg", pkg.getValue("file").jsonPrimitive.content)
            assertEquals(pkgPayload.size.toLong(), pkg.getValue("size").jsonPrimitive.long)
            assertEquals(sha256(pkgPayload), pkg.getValue("sha256").jsonPrimitive.content)
            assertEquals(pkgHeader.toHex(), pkg.getValue("header").jsonPrimitive.content)
            val bin = files[1].jsonObject
            assertEquals("app.bin", bin.getValue("file").jsonPrimitive.content)
            assertEquals(sha256(binPayload), bin.getValue("sha256").jsonPrimitive.content)
            assertEquals(binHeader.toHex(), bin.getValue("header").jsonPrimitive.content)
        }
        console.join()
        val body = leReader(console.side.commands[0].second)
        assertEquals(2, body.int)
        assertEquals(296, body.int)
    }

    @Test
    fun `downloadEntry packageOnly skips non pkg payloads`(@TempDir tempDir: File) {
        val entryId = 296L
        val pkgPayload = "pkg-data".toByteArray()
        val binPayload = "json".toByteArray()
        val console = FakeConsole {
            val transfer = recvCommand()
            sendResponse(0xB2, transfer.sub, 0)
            sendRecord(Gfp5.build(entryId, pkgPayload.size.toLong(), "/user/app/PPSA05688/app.pkg"))
            sendRecord(pkgPayload + ByteArray(5))
            sendRecord(Gfp5.build(entryId, binPayload.size.toLong(), "/user/app/PPSA05688/app.bin"))
            sendRecord(binPayload)
            sendRecord(Gfp5.finalHeader(entryId))
        }.start()
        connectChannel(console.port).use { channel ->
            val manifestFile = Downloads.downloadEntry(channel, entryId, tempDir, packageOnly = true)
            val entryDir = File(tempDir, "296")
            assertArrayEquals(pkgPayload, File(entryDir, "app.pkg").readBytes())
            assertFalse(File(entryDir, "app.bin").exists())
            assertFalse(File(entryDir, "app.bin.part").exists())
            val manifest = Json.parseToJsonElement(manifestFile.readText()).jsonObject
            val entry = manifest.getValue("296").jsonObject
            val files = entry.getValue("files").jsonArray
            assertEquals(1, files.size)
            assertEquals("app.pkg", files[0].jsonObject.getValue("file").jsonPrimitive.content)
            assertEquals(pkgPayload.size.toLong(), files[0].jsonObject.getValue("size").jsonPrimitive.long)
            assertEquals(sha256(pkgPayload), files[0].jsonObject.getValue("sha256").jsonPrimitive.content)
        }
        console.join()
    }

    @Test
    fun `response rejects mismatched cmd and sub`() {
        val console = FakeConsole {
            val command = recvCommand()
            sendResponse(command.cmd, (command.sub + 1) and 0xFF, 0)
        }.start()
        connectChannel(console.port).use { channel ->
            val sub = channel.request(0x92, "hello".toByteArray())
            val error = assertThrows<DtException> { channel.response(0x92, sub) }
            assertTrue(error.message!!.contains("mismatch"))
        }
        console.join()
    }

    @Test
    fun `indexDownloadedManifests rebuilds and prunes the root manifest`(@TempDir tempDir: File) {
        val entryId = 55L
        val payload = "savedata".toByteArray()
        val header = Gfp5.build(entryId, payload.size.toLong(), "/user/home/00000001/savedata/GAME/save0.bin")
        val finalHeader = Gfp5.finalHeader(entryId)
        val console = FakeConsole {
            val transfer = recvCommand()
            sendResponse(0xB2, transfer.sub, 0)
            sendRecord(header)
            sendRecord(payload)
            sendRecord(finalHeader)
        }.start()
        connectChannel(console.port).use { channel ->
            Downloads.downloadEntry(channel, entryId, tempDir)
        }
        console.join()

        val ids = Downloads.indexDownloadedManifests(tempDir)
        assertEquals(setOf(entryId), ids)
        val root = Json.parseToJsonElement(File(tempDir, "manifest.json").readText()).jsonObject
        val entry = root.getValue("55").jsonObject
        assertEquals(finalHeader.toHex(), entry.getValue("final_header").jsonPrimitive.content)
        assertEquals(1, entry.getValue("files").jsonArray.size)

        assertTrue(File(tempDir, "55/save0.bin").delete())
        assertEquals(emptySet<Long>(), Downloads.indexDownloadedManifests(tempDir))
        val pruned = Json.parseToJsonElement(File(tempDir, "manifest.json").readText()).jsonObject
        assertFalse(pruned.containsKey("55"))
    }
}

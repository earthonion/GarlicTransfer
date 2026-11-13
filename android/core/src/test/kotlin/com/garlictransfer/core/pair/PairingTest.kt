package com.garlictransfer.core.pair

import com.garlictransfer.core.DtException
import com.garlictransfer.core.PairingOptions
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.oracle.KeyDeriver
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.source.Events
import com.garlictransfer.core.source.FakeConsole
import com.garlictransfer.core.source.TestPorts
import com.garlictransfer.core.source.udpExchange
import com.garlictransfer.core.util.toHex
import java.io.File
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.atomic.AtomicReference
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir

@Timeout(30)
class PairingTest {

    @TempDir
    lateinit var tempDir: File

    private fun options(discoveryPort: Int = TestPorts.take(), commandPort: Int = TestPorts.take(), duration: Int = 5): PairingOptions =
        PairingOptions(
            ps5Ip = "127.0.0.1",
            hostId = "202122232425",
            systemVersion = "14220000",
            oracleHost = "127.0.0.1",
            oraclePort = 9022,
            prefixPath = File(tempDir, "pairing-prefix.bin").absolutePath,
            durationSec = duration,
            bindIp = "127.0.0.1",
            discoveryPort = discoveryPort,
            commandPort = commandPort,
        )

    private class PairRun(val thread: Thread, val error: AtomicReference<Throwable?>, val result: AtomicReference<File?>)

    private fun runPair(options: PairingOptions, deriver: KeyDeriver = LocalPskDeriver(), listener: TransferListener? = null): PairRun {
        val error = AtomicReference<Throwable?>()
        val result = AtomicReference<File?>()
        val thread = Thread({
            try {
                result.set(Pairing.pair(options, deriver, listener))
            } catch (t: Throwable) {
                error.set(t)
            }
        }, "pair-under-test")
        thread.isDaemon = true
        thread.start()
        return PairRun(thread, error, result)
    }

    private fun awaitFinished(run: PairRun) {
        run.thread.join(25_000)
        assertFalse(run.thread.isAlive, "pair() did not finish")
    }

    @Test
    fun `discovery reply advertises the selected firmware and route`() {
        val search = String(Pairing.discoveryReply("SRCH", "192.0.2.5", "14220000", 1004)!!)
        assertTrue(search.contains("host-name:GarlicTransfer Pairing\n"))
        assertTrue(search.contains("system-version:14220000\n"))
        assertTrue(search.contains("host-request-port:1004\n"))
        val launch = String(Pairing.discoveryReply("LAUNCH4", "192.0.2.5", "14220000", 1004)!!)
        assertTrue(launch.contains("host-address:00000000000000000000ffffc0000205\n"))
        assertNull(Pairing.discoveryReply("OTHER", "192.0.2.5", "14220000", 1004))
    }

    @Test
    fun `validation rejects bad target host version and path`() {
        val base = options()
        base.copy(hostId = "not-a-host").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(hostId = "2021222324").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(systemVersion = "14.22").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(ps5Ip = "::1").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(ps5Ip = "not-an-ip").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(oraclePort = 0).let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(oraclePort = 65536).let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(prefixPath = "").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(prefixPath = "relative-prefix.bin").let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(durationSec = 0).let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
        base.copy(durationSec = 601).let { assertThrows(DtException::class.java) { Pairing.pair(it, LocalPskDeriver()) } }
    }

    @Test
    fun `valid options with no console time out`() {
        val opts = options(duration = 1)
        val events = Events()
        val error = assertThrows(DtException::class.java) { Pairing.pair(opts, LocalPskDeriver(), events) }
        assertEquals("pairing timed out", error.message)
        assertTrue(events.snapshot().any { it is TransferEvent.Error })
    }

    @Test
    fun `one encrypted request pairs without an answer`() {
        val opts = options()
        val events = Events()
        val run = runPair(opts, listener = events)
        assertTrue(events.waitFor(5000) { it is TransferEvent.Status && it.message.contains("Pairing listener ready") })

        val search = udpExchange(opts.discoveryPort, "SRCH * HTTP/1.1\n")
        assertTrue(search.contains("host-name:GarlicTransfer Pairing\n"))
        assertTrue(search.contains("system-version:14220000\n"))
        assertTrue(search.contains("host-request-port:${opts.commandPort}\n"))
        val launch = udpExchange(opts.discoveryPort, "LAUNCH4 * HTTP/1.1\n")
        assertTrue(launch.contains("host-network:0\n"))
        assertTrue(launch.contains("host-address:00000000000000000000ffff7f000001\n"))

        val prefix = ByteArray(32) { it.toByte() }
        val body = prefix + ByteArray(56) { (32 + it).toByte() }
        FakeConsole("127.0.0.1", opts.commandPort).use { client ->
            client.handshake()
            client.request(0x91, body)
            assertEquals(-1, client.socket.getInputStream().read(), "pairing must not send an encrypted response")
        }
        awaitFinished(run)
        assertNull(run.error.get())
        val saved = run.result.get()
        assertNotNull(saved)
        assertEquals(File(opts.prefixPath), saved)
        assertArrayEquals(prefix, saved!!.readBytes())
        assertTrue(events.snapshot().any { it is TransferEvent.Done && it.message == "paired" })
    }

    @Test
    fun `host id mismatch saves nothing and fails`() {
        val opts = options()
        val events = Events()
        val run = runPair(opts, listener = events)
        assertTrue(events.waitFor(5000) { it is TransferEvent.Status && it.message.contains("Pairing listener ready") })

        val prefix = ByteArray(32) { (0xA0 + it).toByte() }
        val body = prefix + ByteArray(56) { (32 + it).toByte() }
        body[32] = 0x00
        body[33] = 0x11
        FakeConsole("127.0.0.1", opts.commandPort).use { client ->
            client.handshake()
            client.request(0x91, body)
            assertEquals(-1, client.socket.getInputStream().read())
        }
        awaitFinished(run)
        val error = run.error.get()
        assertTrue(error is DtException)
        assertEquals("Data Transfer request did not match the selected console", error!!.message)
        assertFalse(File(opts.prefixPath).exists())
        val reported = events.snapshot().filterIsInstance<TransferEvent.Error>().first().message
        assertFalse(reported.contains(prefix.toHex()), "the error must not echo the request: $reported")
    }

    @Test
    fun `non empty completion record fails the handshake`() {
        val opts = options()
        val events = Events()
        val run = runPair(opts, listener = events)
        assertTrue(events.waitFor(5000) { it is TransferEvent.Status && it.message.contains("Pairing listener ready") })

        FakeConsole("127.0.0.1", opts.commandPort).use { client ->
            client.handshake(completion = byteArrayOf(1))
            assertEquals(-1, client.socket.getInputStream().read())
        }
        awaitFinished(run)
        assertTrue(run.error.get() is DtException)
        assertEquals("unexpected handshake completion", run.error.get()!!.message)
        assertFalse(File(opts.prefixPath).exists())
    }

    @Test
    fun `body overshoot fails the request`() {
        val opts = options()
        val events = Events()
        val run = runPair(opts, listener = events)
        assertTrue(events.waitFor(5000) { it is TransferEvent.Status && it.message.contains("Pairing listener ready") })

        FakeConsole("127.0.0.1", opts.commandPort).use { client ->
            client.handshake()
            client.sendRecord(com.garlictransfer.core.crypto.CommandHeader(0x91, 2, 0x130, 0, 88).pack())
            client.sendRecord(ByteArray(100))
            assertEquals(-1, client.socket.getInputStream().read())
        }
        awaitFinished(run)
        assertTrue(run.error.get() is DtException)
        assertEquals("invalid Data Transfer request length", run.error.get()!!.message)
        assertFalse(File(opts.prefixPath).exists())
    }

    @Test
    fun `packets and connections from another address are ignored`() {
        val opts = options(duration = 2).let { it.copy(ps5Ip = "127.0.0.2", bindIp = null) }
        val events = Events()
        val run = runPair(opts, listener = events)
        assertTrue(events.waitFor(5000) { it is TransferEvent.Status && it.message.contains("Pairing listener ready") })

        val udp = DatagramSocket()
        udp.soTimeout = 800
        try {
            val payload = "SRCH * HTTP/1.1\n".toByteArray(Charsets.US_ASCII)
            udp.send(DatagramPacket(payload, payload.size, InetAddress.getByName("127.0.0.1"), opts.discoveryPort))
            assertThrows(SocketTimeoutException::class.java) { udp.receive(DatagramPacket(ByteArray(256), 256)) }
        } finally {
            udp.close()
        }
        java.net.Socket().use { socket ->
            socket.connect(java.net.InetSocketAddress("127.0.0.1", opts.commandPort), 2000)
            socket.soTimeout = 3000
            assertEquals(-1, socket.getInputStream().read(), "a connection from the wrong address must be closed unanswered")
        }
        awaitFinished(run)
        assertTrue(run.error.get() is DtException)
        assertEquals("pairing timed out", run.error.get()!!.message)
        assertFalse(File(opts.prefixPath).exists())
    }

    @Test
    fun `save prefix writes exactly 32 bytes and replaces atomically`() {
        val dest = File(tempDir, "private/pairing-prefix.bin")
        Pairing.savePrefix(ByteArray(32) { it.toByte() }, dest)
        assertArrayEquals(ByteArray(32) { it.toByte() }, dest.readBytes())

        Pairing.savePrefix(ByteArray(32) { (31 - it).toByte() }, dest)
        assertArrayEquals(ByteArray(32) { (31 - it).toByte() }, dest.readBytes())
        assertEquals(listOf(dest.name), dest.parentFile.list()!!.toList(), "no temporary files may be left behind")

        assertThrows(DtException::class.java) { Pairing.savePrefix(ByteArray(5), dest) }
        assertThrows(DtException::class.java) { Pairing.savePrefix(ByteArray(33), dest) }
        assertArrayEquals(ByteArray(32) { (31 - it).toByte() }, dest.readBytes(), "a failed write must keep the old prefix")

        if (dest.toPath().fileSystem.supportedFileAttributeViews().contains("posix")) {
            assertEquals(
                PosixFilePermissions.fromString("rw-------"),
                Files.getPosixFilePermissions(dest.toPath()),
            )
            assertEquals(
                PosixFilePermissions.fromString("rwx------"),
                Files.getPosixFilePermissions(dest.parentFile.toPath()),
            )
        }
    }
}

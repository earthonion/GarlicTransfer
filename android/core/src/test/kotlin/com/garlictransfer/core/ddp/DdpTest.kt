package com.garlictransfer.core.ddp

import com.garlictransfer.core.DtException
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.assertThrows
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

@Timeout(30)
class DdpTest {

    private val responders = mutableListOf<DatagramSocket>()

    @AfterEach
    fun tearDown() {
        for (socket in responders) runCatching { socket.close() }
        responders.clear()
    }

    private fun cannedResponse(): ByteArray = (
        "HTTP/1.1 200 Ok\n" +
            "host-id:5C843CC6D727\n" +
            "host-type:PS5\n" +
            "host-name:TestPS5\n" +
            "host-request-port:1004\n" +
            "device-discovery-protocol-version:00030010\n" +
            "system-version:14220000\n"
        ).toByteArray(Charsets.UTF_8)

    private fun startResponder(repliesPerProbe: Int = 1): DatagramSocket {
        val socket = bindUdp()
        responders.add(socket)
        socket.soTimeout = 200
        Thread({
            val response = cannedResponse()
            while (!socket.isClosed) {
                val packet = DatagramPacket(ByteArray(4096), 4096)
                try {
                    socket.receive(packet)
                } catch (timeout: SocketTimeoutException) {
                    continue
                } catch (failure: Exception) {
                    break
                }
                val request = String(packet.data, 0, packet.length, Charsets.UTF_8)
                if (request.startsWith("SRCH")) {
                    repeat(repliesPerProbe) {
                        socket.send(DatagramPacket(response, response.size, packet.address, packet.port))
                    }
                }
            }
        }, "ddp-responder-${socket.localPort}").apply { isDaemon = true; start() }
        return socket
    }

    private fun bindUdp(): DatagramSocket {
        var lastFailure: Exception? = null
        for (port in 39100..39900) {
            try {
                val socket = DatagramSocket(null)
                socket.bind(InetSocketAddress("127.0.0.1", port))
                return socket
            } catch (failure: Exception) {
                lastFailure = failure
            }
        }
        throw IllegalStateException("no loopback UDP port available", lastFailure)
    }

    @Test
    fun `discover collects and dedupes consoles`() {
        val responder = startResponder(repliesPerProbe = 2)
        val consoles = Ddp.discover(
            timeoutMs = 800,
            port = responder.localPort,
            routes = listOf("" to "127.0.0.1"),
        )
        assertEquals(1, consoles.size)
        val console = consoles.single()
        assertEquals("127.0.0.1", console.host)
        assertEquals("TestPS5", console.name)
        assertEquals("PS5", console.type)
        assertEquals("5C843CC6D727", console.hostId)
        assertEquals("14220000", console.firmware)
        assertEquals("1004", console.requestPort)
        assertEquals("", console.network)
        assertEquals("", console.address)
    }

    @Test
    fun `discoveryVersions parses system versions`() {
        val old = "HTTP/1.1 200 Ok\nsystem-version:13600007\n"
        assertEquals(0x130 to 0x13600007, Ddp.discoveryVersions(old))
        val newer = "HTTP/1.1 200 Ok\nsystem-version:14220000\n"
        assertEquals(0x140 to 0x14220000, Ddp.discoveryVersions(newer))
    }

    @Test
    fun `discoveryVersions rejects missing or invalid versions`() {
        assertThrows<DtException> { Ddp.discoveryVersions("HTTP/1.1 200 Ok\nhost-name:PS5\n") }
        assertThrows<DtException> { Ddp.discoveryVersions("HTTP/1.1 200 Ok\nsystem-version:zz220000\n") }
        assertThrows<DtException> { Ddp.discoveryVersions("HTTP/1.1 200 Ok\nsystem-version:1422000\n") }
    }

    @Test
    fun `field extracts response values`() {
        val response = "HTTP/1.1 200 Ok\nhost-name:MyPS5\nhost-id:5C843CC6D727\n"
        assertEquals("MyPS5", Ddp.field(response, "host-name"))
        assertEquals("5C843CC6D727", Ddp.field(response, "host-id"))
        assertNull(Ddp.field(response, "system-version"))
    }

    @Test
    fun `launchConsole tolerates a launch4 timeout`() {
        val responder = startResponder()
        val response = Ddp.launchConsole("127.0.0.1", port = responder.localPort, skipLaunch = false, timeoutMs = 800)
        assertTrue(response.startsWith("HTTP/1.1 200"))
        assertTrue(response.contains("system-version:14220000"))
    }

    @Test
    fun `launchConsole skipLaunch returns the discovery response`() {
        val responder = startResponder()
        val response = Ddp.launchConsole("127.0.0.1", port = responder.localPort, skipLaunch = true, timeoutMs = 800)
        assertEquals(String(cannedResponse(), Charsets.UTF_8), response)
    }
}

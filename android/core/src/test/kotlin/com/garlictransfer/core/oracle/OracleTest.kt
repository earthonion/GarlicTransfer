package com.garlictransfer.core.oracle

import com.garlictransfer.core.DtException
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.recvExact
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.assertThrows
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference

@Timeout(30)
class OracleTest {

    private fun bindTcp(): ServerSocket {
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

    @Test
    fun `oracleDeriver exchanges handshake values and slices the reply`() {
        val clientValue = ByteArray(16) { it.toByte() }
        val serverValue = ByteArray(16) { (0xF0 + it).toByte() }
        val reply = ByteArray(40) { (it * 3 + 1).toByte() }
        val received = AtomicReference<ByteArray>()
        val server = bindTcp()
        val thread = Thread({
            server.accept().use { socket ->
                socket.soTimeout = 10000
                received.set(recvExact(socket.getInputStream(), 32))
                val output = socket.getOutputStream()
                output.write(reply)
                output.flush()
            }
        }, "fake-oracle").apply { isDaemon = true; start() }
        try {
            val keys = OracleDeriver("127.0.0.1", server.localPort, connectTimeoutMs = 5000, readTimeoutMs = 5000)
                .derive(clientValue, serverValue)
            assertArrayEquals(reply.copyOfRange(0, 16), keys.sendKey)
            assertArrayEquals(reply.copyOfRange(16, 32), keys.recvKey)
            assertArrayEquals(reply.copyOfRange(32, 36), keys.sendNoncePrefix)
            assertArrayEquals(reply.copyOfRange(36, 40), keys.recvNoncePrefix)
            thread.join(10000)
            assertArrayEquals(clientValue + serverValue, received.get())
        } finally {
            server.close()
        }
    }

    @Test
    fun `htos derive submits polls and reads the worker result`() {
        val clientValue = "00112233445566778899aabbccddeeff".hexToBytes()
        val serverValue = "ffeeddccbbaa99887766554433221100".hexToBytes()
        val key1 = "01".repeat(16)
        val key2 = "ab".repeat(16)
        val nonce1 = "a1b2c3d4"
        val nonce2 = "e5f60718"
        val transport = ScriptedTransport(
            postResponse = """{"job_id":"7"}""",
            getResponses = ArrayDeque(listOf("""{"status":"running"}""", """{"status":"done"}""")),
            resultResponse = """{"key1":"$key1","key2":"$key2","nonce1":"$nonce1","nonce2":"$nonce2"}""",
        )
        val keys = HtosDeriver("https://htos.example/", "worker-123", transport, pollIntervalMs = 1, deadlineMs = 5000)
            .derive(clientValue, serverValue)

        assertEquals(1, transport.posts.size)
        val post = transport.posts.single()
        assertEquals("https://htos.example/api/v1/jobs", post.url)
        assertEquals("worker-123", post.headers["X-Worker-Key"])
        assertEquals("ppr_derive", post.fields["operation"])
        assertEquals("00112233445566778899aabbccddeeff", post.fields["client_value"])
        assertEquals("ffeeddccbbaa99887766554433221100", post.fields["server_value"])
        assertEquals(
            listOf(
                "https://htos.example/api/v1/jobs/7",
                "https://htos.example/api/v1/jobs/7",
                "https://htos.example/api/v1/jobs/7/result",
            ),
            transport.gets,
        )
        assertArrayEquals(key1.hexToBytes(), keys.sendKey)
        assertArrayEquals(key2.hexToBytes(), keys.recvKey)
        assertArrayEquals(nonce1.hexToBytes(), keys.sendNoncePrefix)
        assertArrayEquals(nonce2.hexToBytes(), keys.recvNoncePrefix)
    }

    @Test
    fun `htos derive surfaces worker failure logs`() {
        val transport = ScriptedTransport(
            postResponse = """{"job_id":"9"}""",
            getResponses = ArrayDeque(
                listOf("""{"status":"failed","logs":[{"msg":"decrypt blew up"},{"msg":"worker died"}]}"""),
            ),
            resultResponse = """{}""",
        )
        val error = assertThrows<DtException> {
            HtosDeriver("https://htos.example", "worker-123", transport, pollIntervalMs = 1, deadlineMs = 5000)
                .derive(ByteArray(16), ByteArray(16))
        }
        assertTrue(error.message!!.contains("decrypt blew up"))
        assertTrue(error.message!!.contains("worker died"))
    }

    @Test
    fun `htos derive surfaces api errors`() {
        val transport = ScriptedTransport(
            postResponse = """{"error":"unknown worker key"}""",
            getResponses = ArrayDeque(),
            resultResponse = """{}""",
        )
        val error = assertThrows<DtException> {
            HtosDeriver("https://htos.example", "bad-key", transport, pollIntervalMs = 1, deadlineMs = 1000)
                .derive(ByteArray(16), ByteArray(16))
        }
        assertTrue(error.message!!.contains("unknown worker key"))
    }

    private class ScriptedTransport(
        private val postResponse: String,
        private val getResponses: ArrayDeque<String>,
        private val resultResponse: String,
    ) : HttpTransport {
        data class Post(val url: String, val headers: Map<String, String>, val fields: Map<String, String>)

        val posts = mutableListOf<Post>()
        val gets = mutableListOf<String>()

        override fun postMultipart(url: String, headers: Map<String, String>, fields: Map<String, String>): String {
            posts.add(Post(url, headers, fields))
            return postResponse
        }

        override fun get(url: String, headers: Map<String, String>): String {
            gets.add(url)
            return if (url.endsWith("/result")) resultResponse else getResponses.removeFirst()
        }
    }
}

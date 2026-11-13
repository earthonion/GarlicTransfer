package com.garlictransfer.core.source

import com.garlictransfer.core.DtException
import com.garlictransfer.core.UploadConfig
import com.garlictransfer.core.metadata.SqlDbFactory
import com.garlictransfer.core.oracle.LocalPskDeriver
import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir

@Timeout(30)
class SourceDiscoveryTest {

    @TempDir
    lateinit var tempDir: File

    private val noDb = SqlDbFactory { throw DtException("no database expected in this test") }

    @Test
    fun `packed data address accepts ipv4 and ipv6 literals`() {
        assertEquals("00000000000000000000ffffc0a80132", packedDataAddress("192.168.1.50").toHexLower())
        assertEquals("00000000000000000000ffff7f000001", packedDataAddress("127.0.0.1").toHexLower())
        assertEquals("fe800000000000000000000000000001", packedDataAddress("fe80::1").toHexLower())
        assertEquals(16, packedDataAddress("10.0.0.1").size)
    }

    @Test
    fun `ipv4 mapped form matches the captured layout`() {
        assertEquals(
            "00000000000000000000ffffc0a83256",
            ipv4MappedBytes(byteArrayOf(192.toByte(), 168.toByte(), 50.toByte(), 86.toByte())).toHexLower(),
        )
    }

    @Test
    fun `packed data address rejects nonsense`() {
        for (bad in listOf("", "192.168.1", "fe80::1::2", "hello")) {
            assertThrows(DtException::class.java, { packedDataAddress(bad) }, bad)
        }
    }

    @Test
    fun `pinned advertise address beats detection`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val config = UploadConfig(
            metadataPath = File(tempDir, "metadata.db").absolutePath,
            assetsPath = tempDir.absolutePath,
            commandPort = cmd,
            dataPort = data,
            discoveryPort = ddp,
            advertiseAddress = "10.9.8.7",
        )
        UploadServer(config, noDb, Events(), LocalPskDeriver()).use { server ->
            server.start()
            udpExchange(ddp, "SRCH * HTTP/1.1\n")
            val reply = udpExchange(ddp, "LAUNCH4 * HTTP/1.1\n")
            val fields = reply.lines().drop(1).filter { ":" in it }.associate { it.substringBefore(":") to it.substringAfter(":") }
            assertEquals("00000000000000000000ffff0a090807", fields["host-address"])
        }
    }

    private fun ByteArray.toHexLower(): String = joinToString("") { "%02x".format(it) }
}

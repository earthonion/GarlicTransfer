package com.garlictransfer.core.source

import com.garlictransfer.core.DtException
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.UploadConfig
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.metadata.SqlDbFactory
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.power.Power
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leBuffer
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.toHex
import java.io.EOFException
import java.io.File
import java.security.MessageDigest
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.io.TempDir

@Timeout(30)
class UploadServerTest {

    @TempDir
    lateinit var tempDir: File

    private val noDb = SqlDbFactory { throw DtException("no database expected in this test") }

    private fun newConfig(cmd: Int, data: Int, ddp: Int, metadata: File, assets: File): UploadConfig =
        UploadConfig(
            metadataPath = metadata.absolutePath,
            assetsPath = assets.absolutePath,
            commandPort = cmd,
            dataPort = data,
            discoveryPort = ddp,
        )

    private fun startServer(config: UploadConfig, events: Events, dbFactory: SqlDbFactory = noDb): UploadServer =
        UploadServer(config, dbFactory, events, LocalPskDeriver()).apply { start() }

    private fun powerBody(): ByteArray =
        Power.buildPowerRequestBody(0x13600007, 2, "5C843CC6D727", Power.accountHashPrefix("72623859790382856"))

    // --- Discovery ---

    @Test
    fun `srch reply is byte exact`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use { server ->
            val reply = udpExchange(ddp, "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030000\n")
            val expected = "HTTP/1.1 200 Ok\n" +
                "host-id:020000000001\n" +
                "host-request-port:$cmd\n" +
                "device-discovery-protocol-version:00030010\n" +
                "host-type:PS5\n" +
                "host-name:GarlicTransfer\n" +
                "system-version:14200007\n"
            assertEquals(expected, reply)
            assertFalse(reply.contains("host-address:"))
        }
    }

    @Test
    fun `launch4 advertises the detected loopback address`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            udpExchange(ddp, "SRCH * HTTP/1.1\n")
            val reply = udpExchange(ddp, "LAUNCH4 * HTTP/1.1\ndevice-discovery-protocol-version:00030000\n")
            val fields = reply.lines().drop(1).filter { ":" in it }.associate { it.substringBefore(":") to it.substringAfter(":") }
            assertEquals("0", fields["host-network"])
            assertEquals("00000000000000000000ffff7f000001", fields["host-address"])
            assertEquals(cmd.toString(), fields["host-request-port"])
            assertFalse(fields.containsKey("host-name"))
        }
    }

    @Test
    fun `unknown discovery verbs are ignored`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            val client = java.net.DatagramSocket()
            client.soTimeout = 800
            try {
                val payload = "WAKEUP * HTTP/1.1\n".toByteArray(Charsets.US_ASCII)
                client.send(java.net.DatagramPacket(payload, payload.size, java.net.InetAddress.getByName("127.0.0.1"), ddp))
                assertThrows(java.net.SocketTimeoutException::class.java) {
                    client.receive(java.net.DatagramPacket(ByteArray(256), 256))
                }
            } finally {
                client.close()
            }
            assertTrue(udpExchange(ddp, "SRCH * HTTP/1.1\n").contains("200 Ok"))
        }
    }

    // --- Command channel ---

    @Test
    fun `power request waits then answers with console info and the session continues`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val config = newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir)
            .copy(autoPowerDelayMs = 50, advertiseAddress = "10.9.8.7")
        startServer(config, events).use {
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                client.request(0x91, powerBody())
                val (intermediate, intermediateBody) = client.readResponse()
                assertEquals(0x91, intermediate.cmd)
                assertEquals(33L, intermediate.result)
                assertEquals(0, intermediateBody.size)
                assertTrue(events.waitFor { it is TransferEvent.PowerRequired })
                assertTrue(events.waitForLog("press the console power button"))

                val (response, body) = client.readResponse()
                assertEquals(0x91, response.cmd)
                assertEquals(0L, response.result)
                assertEquals(72, body.size)
                assertArrayEquals("020000000001".hexToBytes(), body.copyOfRange(0, 6))
                assertEquals(1, body[6].toInt())
                assertEquals(2, leReader(body).apply { position(8) }.int)
                assertEquals(0x282, leReader(body).apply { position(12) }.int)
                assertEquals(1, leReader(body).apply { position(16) }.short.toInt())
                assertEquals(1, leReader(body).apply { position(18) }.short.toInt())
                assertEquals('n'.code.toByte(), body[20])
                assertEquals('p'.code.toByte(), body[21])
                assertEquals(0x13600007, leReader(body).apply { position(32) }.int)
                assertEquals(1, leReader(body).apply { position(40) }.int)
                assertEquals(0x13600007, leReader(body).apply { position(44) }.int)
                assertArrayEquals("00000000000000000000ffff0a090807".hexToBytes(), body.copyOfRange(48, 64))

                client.request(0x93, powerBody())
                val (auth, authBody) = client.readResponse()
                assertEquals(0x93, auth.cmd)
                assertEquals(0L, auth.result)
                assertEquals(72, authBody.size)

                client.request(0x94)
                val (close, closeBody) = client.readResponse()
                assertEquals(0x94, close.cmd)
                assertEquals(0L, close.result)
                assertEquals(0, closeBody.size)
                assertThrows(EOFException::class.java) { client.readRecord() }
            }
            assertTrue(events.waitForLog("[cmd] cmd=0x91"))
            assertTrue(events.waitForLog("response complete cmd=0x91 result=33"))
            assertTrue(events.waitForLog("response complete cmd=0x91 result=0"))
            assertTrue(events.waitForLog("response complete cmd=0x94 result=0"))
            assertTrue(events.waitForLog("[cmd] session ended"))
        }
    }

    @Test
    fun `power request is released by signalPower`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use { server ->
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                client.request(0x91, powerBody())
                assertEquals(33L, client.readResponse().first.result)
                assertTrue(events.waitFor { it is TransferEvent.PowerRequired })
                server.signalPower()
                val (response, body) = client.readResponse()
                assertEquals(0L, response.result)
                assertEquals(72, body.size)
            }
        }
    }

    @Test
    fun `pairing prefix is cached from a matching power request`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val prefixFile = File(tempDir, "pairings/prefix.bin")
        val config = newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir)
            .copy(autoPowerDelayMs = 50, pairingPrefixPath = prefixFile.absolutePath, expectedHostId = "5C843CC6D727")
        startServer(config, events).use {
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                client.request(0x91, powerBody())
                assertEquals(33L, client.readResponse().first.result)
                assertEquals(0L, client.readResponse().first.result)
            }
            assertTrue(prefixFile.isFile)
            assertArrayEquals(Power.accountHashPrefix("72623859790382856"), prefixFile.readBytes())
            assertTrue(events.waitForLog("[pairing] cached console approval"))
        }
    }

    @Test
    fun `mismatched power request drops the session without caching`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val prefixFile = File(tempDir, "pairings/prefix.bin")
        val config = newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir)
            .copy(autoPowerDelayMs = 50, pairingPrefixPath = prefixFile.absolutePath, expectedHostId = "000000000001")
        startServer(config, events).use {
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                client.request(0x91, powerBody())
                assertThrows(EOFException::class.java) { client.readResponse() }
            }
            assertFalse(prefixFile.exists())
            assertTrue(events.waitForLog("session ended"))
        }
    }

    @Test
    fun `unknown command gets result 2 and ends the session`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                client.request(0x77)
                val (response, body) = client.readResponse()
                assertEquals(0x77, response.cmd)
                assertEquals(2L, response.result)
                assertEquals(0, body.size)
                assertThrows(EOFException::class.java) { client.readRecord() }
            }
            assertTrue(events.waitForLog("response complete cmd=0x77 result=2"))
        }
    }

    @Test
    fun `echo command returns the body and ends the session`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                val message = "HELLO-DT-PSK".toByteArray()
                client.request(0x92, message)
                val (response, body) = client.readResponse()
                assertEquals(0x92, response.cmd)
                assertEquals(0L, response.result)
                assertArrayEquals(message, body)
                assertThrows(EOFException::class.java) { client.readRecord() }
            }
        }
    }

    @Test
    fun `a1 sends an extra record after the response and the session continues`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            FakeConsole("127.0.0.1", cmd).use { client ->
                client.handshake()
                client.request(0xA1)
                val (response, body) = client.readResponse()
                assertEquals(0xA1, response.cmd)
                assertEquals(0L, response.result)
                assertEquals(0, body.size)
                assertArrayEquals(leBuffer(4).putInt(1000).array(), client.readRecord())
                client.request(0x94)
                assertEquals(0L, client.readResponse().first.result)
                assertThrows(EOFException::class.java) { client.readRecord() }
            }
        }
    }

    // --- Data channel ---

    @Test
    fun `data channel a0 sends six busy results then success`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            FakeConsole("127.0.0.1", data).use { client ->
                client.handshake()
                client.request(0xA0, leBuffer(8).putLong(11).array())
                for (step in 0..5) {
                    val (response, _) = client.readResponse()
                    assertEquals(0xA0, response.cmd)
                    assertEquals(0x23L, response.result)
                    assertEquals(0L, response.bodySize)
                }
                val (done, _) = client.readResponse()
                assertEquals(0L, done.result)
            }
        }
    }

    @Test
    fun `data channel b2 type 1 serves the metadata file in chunks`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val metadataBytes = ByteArray(2_100_000) { (it % 251).toByte() }
        val metadata = File(tempDir, "metadata.db").apply { writeBytes(metadataBytes) }
        startServer(newConfig(cmd, data, ddp, metadata, tempDir), events).use {
            FakeConsole("127.0.0.1", data).use { client ->
                client.handshake()
                client.request(0xB2, leBuffer(8).putInt(1).putInt(1).array())
                val (response, body) = client.readResponse()
                assertEquals(0xB2, response.cmd)
                assertEquals(0L, response.result)
                assertEquals(metadataBytes.size.toLong(), response.bodySize)
                assertArrayEquals(metadataBytes, body)
            }
        }
    }

    @Test
    fun `data channel b2 type 2 streams gfp5 header payload and final header`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val entryId = 137L
        val assets = File(tempDir, "assets").apply { mkdirs() }
        val payload = ByteArray(5000) { (it * 31 % 251).toByte() }
        File(assets, "$entryId").mkdirs()
        File(assets, "$entryId/sdimg_test.bin").writeBytes(payload)
        val savePath = "/user/home/00000001/savedata_prospero/CUSA00001/sdimg_test.bin"
        val header = Gfp5.build(entryId, payload.size.toLong(), savePath)
        val finalHeader = Gfp5.finalHeader(entryId)
        val sha = MessageDigest.getInstance("SHA-256").digest(payload).toHex()
        val item = """{"path": "$savePath", "file": "sdimg_test.bin", "size": ${payload.size}, "sha256": "$sha", "header": "${header.toHex()}"}"""
        File(assets, "manifest.json").writeText(
            """
            {
              "entry_id": $entryId,
              "files": [$item],
              "$entryId": {"files": [$item], "final_header": "${finalHeader.toHex()}"}
            }
            """.trimIndent()
        )
        val metadata = File(tempDir, "metadata.db")
        jdbcSqlDbFactory().open(metadata).use { db ->
            db.exec("CREATE TABLE dir_entry_info_tbl (id INTEGER, path TEXT, target_type INTEGER, actual_size INTEGER, transfer_size INTEGER, required_size INTEGER)")
            db.exec("INSERT INTO dir_entry_info_tbl VALUES ($entryId, '/user/home/00000001/savedata_prospero/CUSA00001/', 3, 1, 1, 1)")
            db.exec("CREATE TABLE users_savedata_tbl (user_id INTEGER, title_id TEXT, size INTEGER, bu_size INTEGER)")
            db.exec("INSERT INTO users_savedata_tbl VALUES (1, 'CUSA00001', 1, 0)")
        }
        startServer(newConfig(cmd, data, ddp, metadata, assets), events, jdbcSqlDbFactory()).use {
            FakeConsole("127.0.0.1", data).use { client ->
                client.handshake()
                client.request(0xB2, leBuffer(8).putInt(2).putInt(entryId.toInt()).array())
                val (response, body) = client.readResponse()
                assertEquals(0L, response.result)
                assertEquals(0, body.size)

                val fileHeader = Gfp5.parse(client.readRecord())
                assertEquals(entryId, fileHeader.fileId)
                assertEquals(payload.size.toLong(), fileHeader.size)
                assertFalse(fileHeader.isFinal)
                assertEquals(savePath, fileHeader.path)

                val received = java.io.ByteArrayOutputStream()
                while (received.size() < payload.size) {
                    received.write(client.readRecord())
                }
                assertArrayEquals(payload, received.toByteArray())

                val last = Gfp5.parse(client.readRecord())
                assertEquals(entryId, last.fileId)
                assertTrue(last.isFinal)
            }
            assertTrue(events.waitForLog("[data] GFP5 id=$entryId type=2"))
            assertTrue(events.waitForLog("[data] GFP5 final header id=$entryId"))
        }
    }

    @Test
    fun `data channel b2 without a manifest sends a synthesized final header`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val assets = File(tempDir, "assets").apply { mkdirs() }
        val metadata = File(tempDir, "metadata.db").apply { writeBytes(ByteArray(16)) }
        startServer(newConfig(cmd, data, ddp, metadata, assets), events).use {
            FakeConsole("127.0.0.1", data).use { client ->
                client.handshake()
                client.request(0xB2, leBuffer(8).putInt(2).putInt(999).array())
                val (response, _) = client.readResponse()
                assertEquals(0L, response.result)
                assertEquals(0L, response.bodySize)
                val finalHeader = Gfp5.parse(client.readRecord())
                assertEquals(999L, finalHeader.fileId)
                assertTrue(finalHeader.isFinal)
                assertTrue(events.waitForLog("noent"))
            }
        }
    }

    @Test
    fun `data channel b4 reads the registry`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            FakeConsole("127.0.0.1", data).use { client ->
                client.handshake()
                val body = leBuffer(16).putInt(0x02020000).putInt(0xFFFFFF41.toInt()).putLong(4).array()
                client.request(0xB4, body)
                val (response, _) = client.readResponse()
                assertEquals(0L, response.result)
                val descriptor = client.readRecord()
                assertEquals(24, descriptor.size)
                assertArrayEquals(leBuffer(4).putInt(0x35505247).array(), descriptor.copyOfRange(0, 4))
                assertArrayEquals(body.copyOfRange(0, 4), descriptor.copyOfRange(4, 8))
                assertArrayEquals(leBuffer(8).putLong(0x41).array(), descriptor.copyOfRange(8, 16))
                assertArrayEquals(body.copyOfRange(8, 16), descriptor.copyOfRange(16, 24))
                assertArrayEquals(leBuffer(4).putInt(1).array(), client.readRecord())

                val other = leBuffer(16).putInt(0x1234).putInt(0).putLong(6).array()
                client.request(0xB4, other)
                assertEquals(0L, client.readResponse().first.result)
                client.readRecord()
                assertArrayEquals(ByteArray(6), client.readRecord())
            }
        }
    }

    @Test
    fun `data channel b5 reads the user registry login id`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        val metadata = File(tempDir, "metadata.db")
        jdbcSqlDbFactory().open(metadata).use { db ->
            db.exec("CREATE TABLE user_info_tbl (user_id INTEGER, login_id TEXT)")
            db.exec("INSERT INTO user_info_tbl VALUES (287454020, 'playerone')")
        }
        startServer(newConfig(cmd, data, ddp, metadata, tempDir), events, jdbcSqlDbFactory()).use {
            FakeConsole("127.0.0.1", data).use { client ->
                client.handshake()
                val body = leBuffer(24).putInt(0x11223344).putInt(0x101).putInt(1).putInt(0).putLong(16).array()
                client.request(0xB5, body)
                assertEquals(0L, client.readResponse().first.result)
                val descriptor = client.readRecord()
                assertEquals(24, descriptor.size)
                assertArrayEquals(leBuffer(4).putInt(0x35525547).array(), descriptor.copyOfRange(0, 4))
                assertArrayEquals(body.copyOfRange(0, 12), descriptor.copyOfRange(4, 16))
                assertArrayEquals(body.copyOfRange(16, 24), descriptor.copyOfRange(16, 24))
                val value = client.readRecord()
                assertEquals(16, value.size)
                assertArrayEquals(("playerone" + "\u0000").toByteArray() + ByteArray(6), value)

                val unknown = leBuffer(24).putInt(0x11223344).putInt(0x102).putInt(1).putInt(0).putLong(8).array()
                client.request(0xB5, unknown)
                assertEquals(0L, client.readResponse().first.result)
                client.readRecord()
                assertArrayEquals(ByteArray(8), client.readRecord())
            }
        }
    }

    // --- Lifecycle ---

    @Test
    fun `b3 on the data channel then 0x94 completes the transfer with a Done event`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val events = Events()
        startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), events).use {
            FakeConsole("127.0.0.1", cmd).use { command ->
                FakeConsole("127.0.0.1", data).use { dataChannel ->
                    command.handshake()
                    dataChannel.handshake()
                    dataChannel.request(0xB3, leBuffer(8).putInt(2).putInt(0).array())
                    val (b3, _) = dataChannel.readResponse()
                    assertEquals(0xB3, b3.cmd)
                    assertEquals(0L, b3.result)
                    assertThrows(EOFException::class.java) { dataChannel.readRecord() }

                    command.request(0x94)
                    assertEquals(0L, command.readResponse().first.result)
                    assertThrows(EOFException::class.java) { command.readRecord() }
                }
            }
            assertTrue(events.waitForLog("cmd=0xb3"))
            assertTrue(events.waitForLog("response complete cmd=0xb3"))
            assertTrue(events.waitForLog("response complete cmd=0x94"))
            assertTrue(events.waitFor { it is TransferEvent.Done && it.message == "console closed the transfer session" })
        }
    }

    @Test
    fun `stop is idempotent`() {
        val cmd = TestPorts.take(); val data = TestPorts.take(); val ddp = TestPorts.take()
        val server = startServer(newConfig(cmd, data, ddp, File(tempDir, "metadata.db"), tempDir), Events())
        assertTrue(server.isRunning)
        server.stop()
        assertFalse(server.isRunning)
        server.stop()
        assertFalse(server.isRunning)
    }
}

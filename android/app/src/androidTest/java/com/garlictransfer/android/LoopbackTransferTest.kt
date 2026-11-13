package com.garlictransfer.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.garlictransfer.android.db.AndroidSqlDbFactory
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.UploadConfig
import com.garlictransfer.core.channel.Downloads
import com.garlictransfer.core.channel.DtChannel
import com.garlictransfer.core.crypto.commandHeader
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.metadata.EntryManifest
import com.garlictransfer.core.metadata.Metadata
import com.garlictransfer.core.metadata.PayloadFile
import com.garlictransfer.core.metadata.toJson
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.power.Power
import com.garlictransfer.core.source.UploadServer
import com.garlictransfer.core.util.toHex
import com.garlictransfer.core.util.u64ToLe
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Full emulated transfer on-device: the app's UploadServer plays the PS5 source console,
 * a DtChannel client plays the console pulling saves — the exact wire protocol, on loopback.
 */
@RunWith(AndroidJUnit4::class)
class LoopbackTransferTest {

    private val deriver = LocalPskDeriver()
    private lateinit var workDir: File
    private lateinit var assetsDir: File
    private lateinit var server: UploadServer
    private val events = mutableListOf<TransferEvent>()

    private val entryId = 137L
    private val userId = "138c0dbf"
    private val titleId = "PPSA01289"
    private val commandPort = 39210
    private val dataPort = 39211

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        workDir = File(context.cacheDir, "loopback-${System.nanoTime()}").apply { mkdirs() }
        assetsDir = File(workDir, "assets").apply { mkdirs() }
    }

    @After
    fun tearDown() {
        if (::server.isInitialized) server.stop()
        workDir.deleteRecursively()
    }

    private fun writePayload(name: String, consolePath: String, bytes: ByteArray): PayloadFile {
        File(assetsDir, entryId.toString()).mkdirs()
        File(assetsDir, "$entryId/$name").writeBytes(bytes)
        val header = Gfp5.build(entryId, bytes.size.toLong(), consolePath)
        return PayloadFile(
            path = consolePath,
            file = name,
            size = bytes.size.toLong(),
            sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).toHex(),
            header = header.toHex(),
        )
    }

    @Test(timeout = 60_000)
    fun fullTransferLoopback() {
        val random = SecureRandom()
        val saveImage = ByteArray(128 * 1024).also(random::nextBytes)
        val backupImage = ByteArray(4096).also(random::nextBytes)
        val savePath = "/user/home/$userId/savedata_prospero/$titleId/sdimg0"
        val backupPath = "/user/home/$userId/savedata_prospero/$titleId/sce_bu_save.bin"
        val files = mutableListOf(
            writePayload("sdimg0", savePath, saveImage),
            writePayload("sce_bu_save.bin", backupPath, backupImage),
        )
        val manifest = EntryManifest(entryId, files, Gfp5.finalHeader(entryId).toHex())
        File(assetsDir, "manifest.json").writeText(manifest.toJson())

        val metadataDb = Metadata.createMetadata(
            dbFactory = AndroidSqlDbFactory,
            output = File(workDir, "metadata.db"),
            userId = userId,
            titleId = titleId,
            entryId = entryId,
            assets = assetsDir,
            userName = "emulated",
        )

        val listener = TransferListener { event -> synchronized(events) { events.add(event) } }
        server = UploadServer(
            config = UploadConfig(
                metadataPath = metadataDb.absolutePath,
                assetsPath = assetsDir.absolutePath,
                manifestPath = File(assetsDir, "manifest.json").absolutePath,
                commandPort = commandPort,
                dataPort = dataPort,
                discoveryPort = 39212,
                systemVersion = "14200007",
                useLocalPsk = true,
                autoPowerDelayMs = 200,
            ),
            dbFactory = AndroidSqlDbFactory,
            listener = listener,
            deriverOverride = deriver,
        )
        server.start()
        assertTrue(server.isRunning)

        DtChannel("127.0.0.1", commandPort, deriver, version = 0x140).use { command ->
            command.connect()
            val sub = command.request(0x91, Power.buildPowerRequestBody(0x14200007, 3, "020000000001", null))
            val intermediate = command.response(0x91, sub)
            assertEquals(33L, intermediate.result)
            val approval = command.response(0x91, sub)
            assertEquals(0L, approval.result)
            assertEquals(72, approval.body.size)

            DtChannel("127.0.0.1", dataPort, deriver, version = 0x140).use { data ->
                data.connect()
                val downloadDir = File(workDir, "download").apply { mkdirs() }

                val metadataFile = Downloads.downloadMetadata(data, downloadDir)
                assertArrayEquals(metadataDb.readBytes(), metadataFile.readBytes())

                val entryManifestFile = Downloads.downloadEntry(data, entryId, downloadDir)
                assertArrayEquals(saveImage, File(downloadDir, "$entryId/sdimg0").readBytes())
                assertArrayEquals(backupImage, File(downloadDir, "$entryId/sce_bu_save.bin").readBytes())
                assertTrue(entryManifestFile.isFile)
                assertEquals(setOf(entryId), Downloads.indexDownloadedManifests(downloadDir))
            }

            val bye = command.request(0x94, u64ToLe(0))
            assertEquals(0L, command.response(0x94, bye).result)
        }

        server.stop()
        val logs = synchronized(events) { events.filterIsInstance<TransferEvent.Log>().map { it.message } }
        assertTrue(logs.any { it.contains("cmd=0x91") })
        assertTrue(logs.any { it.contains("response complete cmd=0x94") })
    }
}

package com.garlictransfer.core.metadata

import com.garlictransfer.core.DtException
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leReader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ExternalSaveTest {

    @TempDir
    lateinit var root: File

    private fun image(name: String = "sdimg_external", payload: ByteArray = "encrypted-save".toByteArray()): File =
        File(root, name).apply { writeBytes(payload) }

    @Test
    fun `new container creates an uploadable library entry`() {
        val image = image()
        val assets = File(root, "cache")
        val output = File(root, "metadata.db")
        val manifestOutput = File(root, "manifest.json")
        val source = sourceDb(root, "18c60ea2")
        Metadata.createExternalSave(
            JdbcSqlDb.Factory, output, "18c60ea2", "PPSA12345", image, assets, "tester",
            manifestOutput = manifestOutput, sourceMetadata = source,
        )
        val expectedPath = "/user/home/18c60ea2/savedata_prospero/PPSA12345/"
        withDb(output) { db ->
            val directory = db.queryOne("SELECT path, actual_size, transfer_size, required_size FROM dir_entry_info_tbl") {
                listOf(it.getString(0), it.getLong(1), it.getLong(2), it.getLong(3))
            }
            assertEquals(listOf(expectedPath, 14L, 14L, 14L), directory)
            assertEquals(
                "PPSA12345" to 14L,
                db.queryOne("SELECT title_id, size FROM users_savedata_tbl") { it.getString(0) to it.getLong(1) },
            )
        }
        val manifest = Json.parseToJsonElement(manifestOutput.readText()).jsonObject
        val item = manifest.getValue("65536").jsonObject.getValue("files").jsonArray[0].jsonObject
        assertEquals(expectedPath + "sdimg_external", item.getValue("path").jsonPrimitive.content)
        val header = item.getValue("header").jsonPrimitive.content.hexToBytes()
        assertEquals(EXTERNAL_SAVE_ENTRY_ID, leReader(header).getInt(4).toLong() and 0xFFFFFFFFL)
        assertEquals(14L, leReader(header).getLong(240))
        assertTrue(File(assets, "65536/sdimg_external").readBytes().contentEquals("encrypted-save".toByteArray()))
        val entryManifest = Json.parseToJsonElement(File(assets, "65536/manifest.json").readText()).jsonObject
        assertEquals(EXTERNAL_SAVE_ENTRY_ID, entryManifest.getValue("entry_id").jsonPrimitive.long)
        assertTrue(entryManifest.getValue("65536").jsonObject.containsKey("final_header"))
    }

    @Test
    fun `external save allows a user without a prior download`() {
        val output = File(root, "metadata.db")
        Metadata.createExternalSave(
            JdbcSqlDb.Factory, output, "18c60ea2", "PPSA12345", image(), File(root, "cache"), "tester",
        )
        assertTrue(output.isFile)
        withDb(output) { db ->
            assertEquals("18c60ea2".toLong(16), db.queryOne("SELECT user_id FROM user_info_tbl") { it.getLong(0) })
        }
    }

    @Test
    fun `external save rejects bad input`() {
        var error = assertThrows(DtException::class.java) {
            Metadata.createExternalSave(
                JdbcSqlDb.Factory, File(root, "m.db"), "18c60ea2", "PPSA12345",
                image(payload = ByteArray(0)), File(root, "cache"), "tester",
            )
        }
        assertTrue(error.message!!.contains("external save container is missing or empty"))
        error = assertThrows(DtException::class.java) {
            Metadata.createExternalSave(
                JdbcSqlDb.Factory, File(root, "m2.db"), "18c60ea2", "BAD",
                image(), File(root, "cache"), "tester",
            )
        }
        assertTrue(error.message!!.contains("title ID must be exactly 9 letters or digits"))
        error = assertThrows(DtException::class.java) {
            Metadata.createExternalSave(
                JdbcSqlDb.Factory, File(root, "m3.db"), "not-hex", "PPSA12345",
                image(), File(root, "cache"), "tester",
            )
        }
        assertTrue(error.message!!.contains("user ID must be exactly 8 hexadecimal digits"))
    }
}

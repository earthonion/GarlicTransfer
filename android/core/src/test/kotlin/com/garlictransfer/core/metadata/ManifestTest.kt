package com.garlictransfer.core.metadata

import com.garlictransfer.core.DtException
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

class ManifestTest {

    @TempDir
    lateinit var root: File

    @Test
    fun `toJson writes the downloader dual shape`() {
        val item = PayloadFile("/user/home/138c0dbf/savedata_prospero/PPSA01289/save.bin", "save.bin", 8, "aa", "bb")
        val manifest = EntryManifest(137, mutableListOf(item), "cc")
        val document = Json.parseToJsonElement(manifest.toJson()).jsonObject
        assertEquals(137L, document.getValue("entry_id").jsonPrimitive.long)
        val fileJson = document.getValue("files").jsonArray[0].jsonObject
        assertEquals(setOf("path", "file", "size", "sha256", "header"), fileJson.keys)
        assertEquals("/user/home/138c0dbf/savedata_prospero/PPSA01289/save.bin", fileJson.getValue("path").jsonPrimitive.content)
        assertEquals(8L, fileJson.getValue("size").jsonPrimitive.long)
        val entry = document.getValue("137").jsonObject
        assertEquals("cc", entry.getValue("final_header").jsonPrimitive.content)
        assertEquals("save.bin", entry.getValue("files").jsonArray[0].jsonObject.getValue("file").jsonPrimitive.content)
    }

    @Test
    fun `parseEntryManifest accepts top level files and final header`() {
        val parsed = parseEntryManifest(
            137,
            """{"files": [{"path": "/p/s.bin", "file": "s.bin", "size": 3, "sha256": "aa", "header": "bb"}], "final_header": "cc"}""",
        )
        assertEquals(137L, parsed.entryId)
        assertEquals("cc", parsed.finalHeader)
        assertEquals(listOf(PayloadFile("/p/s.bin", "s.bin", 3, "aa", "bb")), parsed.files)
    }

    @Test
    fun `parseEntryManifest accepts the entry sub object`() {
        val manifest = EntryManifest(137, mutableListOf(PayloadFile("/p/s.bin", "s.bin", 3, "aa", "bb")), "cc")
        val parsed = parseEntryManifest(137, manifest.toJson())
        assertEquals(manifest.entryId, parsed.entryId)
        assertEquals(manifest.finalHeader, parsed.finalHeader)
        assertEquals(manifest.files, parsed.files)
    }

    @Test
    fun `parseEntryManifest rejects missing pieces`() {
        assertThrows(DtException::class.java) { parseEntryManifest(137, "{}") }
        assertThrows(DtException::class.java) { parseEntryManifest(137, """{"files": [], "final_header": "cc"}""") }
        assertThrows(DtException::class.java) {
            parseEntryManifest(137, """{"files": [{"path": "/p", "file": "f", "size": 1, "sha256": "", "header": ""}]}""")
        }
        assertThrows(DtException::class.java) { parseEntryManifest(137, "not json") }
    }

    @Test
    fun `singleSaveDb extracts a valid template database`() {
        val extracted = MetadataTemplates.singleSaveDb(root)
        assertTrue(extracted.isFile)
        withDb(extracted) { db ->
            assertEquals(1L, db.query("SELECT COUNT(*) FROM user_info_tbl") { it.getLong(0) }[0])
            val row = db.queryOne("SELECT id, path, target_type FROM dir_entry_info_tbl") {
                Triple(it.getLong(0), it.getString(1), it.getLong(2))
            }
            assertEquals(Triple(137L, "/user/home/138c0dbf/savedata_prospero/PPSA01289/", 3L), row)
        }
    }
}

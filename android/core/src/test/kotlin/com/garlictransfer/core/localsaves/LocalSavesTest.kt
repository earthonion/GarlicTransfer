package com.garlictransfer.core.localsaves

import com.garlictransfer.core.DtException
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.metadata.EntryManifest
import com.garlictransfer.core.metadata.PayloadFile
import com.garlictransfer.core.metadata.prettyPrint
import com.garlictransfer.core.metadata.sha256Hex
import com.garlictransfer.core.metadata.toJson
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.toHex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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

class LocalSavesTest {

    @TempDir
    lateinit var root: File

    private val entryId = 150L
    private val savePath = "/user/home/18c60ea2/savedata_prospero/PPSA24003/sdimg_DATA"

    private fun makeCase(): File {
        val assets = File(root, "assets")
        val entryDir = File(assets, entryId.toString())
        entryDir.mkdirs()
        val item = PayloadFile(savePath, "sdimg_DATA", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())
        val manifest = EntryManifest(entryId, mutableListOf(item), Gfp5.finalHeader(entryId).toHex())
        val entryJson = Json.parseToJsonElement(manifest.toJson()).jsonObject.getValue(entryId.toString())
        File(assets, "manifest.json").writeText(prettyPrint(JsonObject(mapOf(entryId.toString() to entryJson))) + "\n")
        File(entryDir, "manifest.json").writeText(manifest.toJson() + "\n")
        File(entryDir, "sdimg_DATA").writeBytes("old-save".toByteArray())
        return assets
    }

    @Test
    fun `inventory hashes the actual file`() {
        val entries = LocalSaves.inventory(makeCase())
        assertEquals(1, entries.size)
        val entry = entries[0]
        assertEquals(entryId, entry.id)
        assertEquals("PPSA24003", entry.title)
        assertEquals("18c60ea2", entry.owner)
        assertEquals(
            listOf(LocalFile("sdimg_DATA", savePath, 8, sha256Hex("old-save".toByteArray()))),
            entry.files,
        )
    }

    @Test
    fun `inventory rejects an empty library`() {
        val assets = File(root, "assets").apply { mkdirs() }
        val error = assertThrows(DtException::class.java) { LocalSaves.inventory(assets) }
        assertTrue(error.message!!.contains("no downloaded saves"))
    }

    @Test
    fun `export copies the file`() {
        val assets = makeCase()
        val destination = File(root, "export").apply { mkdirs() }
        val output = LocalSaves.export(assets, entryId, "sdimg_DATA", destination)
        assertEquals("old-save".toByteArray().toList(), output.readBytes().toList())
        assertEquals("old-save".toByteArray().toList(), File(assets, "$entryId/sdimg_DATA").readBytes().toList())
    }

    @Test
    fun `export requires an existing destination directory`() {
        val assets = makeCase()
        val error = assertThrows(DtException::class.java) {
            LocalSaves.export(assets, entryId, "sdimg_DATA", File(root, "missing"))
        }
        assertTrue(error.message!!.contains("select an existing export directory"))
    }

    @Test
    fun `export refuses to overwrite the source`() {
        val assets = makeCase()
        val error = assertThrows(DtException::class.java) {
            LocalSaves.export(assets, entryId, "sdimg_DATA", File(assets, entryId.toString()))
        }
        assertTrue(error.message!!.contains("the export destination is the same as the source file"))
    }

    @Test
    fun `import replaces the file and regenerates both manifests`() {
        val assets = makeCase()
        val payload = "new-save!!".toByteArray()
        val source = File(root, "replacement").apply { writeBytes(payload) }
        val refreshed = LocalSaves.import(assets, entryId, "sdimg_DATA", source)
        val target = File(assets, "$entryId/sdimg_DATA")
        assertEquals(payload.toList(), target.readBytes().toList())
        assertEquals(payload.toList(), source.readBytes().toList())
        val expectedHash = sha256Hex(payload)
        assertEquals(payload.size.toLong(), refreshed.files[0].size)
        assertEquals(expectedHash, refreshed.files[0].sha256)
        for (manifestPath in listOf(File(assets, "manifest.json"), File(target.parentFile, "manifest.json"))) {
            val item = Json.parseToJsonElement(manifestPath.readText())
                .jsonObject.getValue(entryId.toString()).jsonObject
                .getValue("files").jsonArray[0].jsonObject
            assertEquals(payload.size.toLong(), item.getValue("size").jsonPrimitive.long)
            assertEquals(expectedHash, item.getValue("sha256").jsonPrimitive.content)
            assertEquals(
                payload.size.toLong(),
                leReader(item.getValue("header").jsonPrimitive.content.hexToBytes()).getLong(240),
            )
        }
        assertTrue(File(assets, "$entryId/sdimg_DATA.import.tmp").exists().not())
    }

    @Test
    fun `import rejects a missing or empty source`() {
        val assets = makeCase()
        var error = assertThrows(DtException::class.java) {
            LocalSaves.import(assets, entryId, "sdimg_DATA", File(root, "missing"))
        }
        assertTrue(error.message!!.contains("the import image is missing or empty"))
        val empty = File(root, "empty").apply { writeBytes(ByteArray(0)) }
        error = assertThrows(DtException::class.java) { LocalSaves.import(assets, entryId, "sdimg_DATA", empty) }
        assertTrue(error.message!!.contains("the import image is missing or empty"))
    }

    @Test
    fun `import refuses to replace the file with itself`() {
        val assets = makeCase()
        val error = assertThrows(DtException::class.java) {
            LocalSaves.import(assets, entryId, "sdimg_DATA", File(assets, "$entryId/sdimg_DATA"))
        }
        assertTrue(error.message!!.contains("the import source and destination are the same file"))
    }

    @Test
    fun `import rejects an unknown filename`() {
        val assets = makeCase()
        val source = File(root, "replacement").apply { writeBytes("new-save".toByteArray()) }
        val error = assertThrows(DtException::class.java) { LocalSaves.import(assets, entryId, "nope.bin", source) }
        assertTrue(error.message!!.contains("save file nope.bin is not present in entry 150"))
    }
}

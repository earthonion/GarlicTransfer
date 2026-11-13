package com.garlictransfer.core.metadata

import com.garlictransfer.core.DtException
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.toHex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

class MetadataSafetyTest {

    @TempDir
    lateinit var root: File

    private val userId = "138c0dbf"
    private val entryId = 137L
    private val titleId = "PPSA01289"
    private val savePath = "/user/home/$userId/savedata_prospero/$titleId/save.bin"

    private fun makeCase(): Pair<File, File> {
        val assets = saveCase(root, userId, entryId, titleId, listOf("save.bin" to "12345678".toByteArray()))
        return assets to sourceDb(root, userId)
    }

    private fun generate(assets: File, source: File, user: String = userId): File =
        Metadata.createFilteredMetadata(
            JdbcSqlDb.Factory, File(root, "generated.db"), source, user, "test-user",
            listOf(entryId), assets, File(root, "generated-manifest.json"),
        )

    private fun generatedManifestItem(): JsonObject =
        Json.parseToJsonElement(File(root, "generated-manifest.json").readText())
            .jsonObject.getValue(entryId.toString()).jsonObject
            .getValue("files").jsonArray[0].jsonObject

    private fun manifestItemHeader(manifestFile: File): ByteArray =
        Json.parseToJsonElement(manifestFile.readText()).jsonObject
            .getValue("files").jsonArray[0].jsonObject.getValue("header").jsonPrimitive.content.hexToBytes()

    private fun rewriteManifestHeader(manifestFile: File, headerHex: String) {
        val document = Json.parseToJsonElement(manifestFile.readText()).jsonObject
        fun patch(obj: JsonObject): JsonObject {
            val files = obj.getValue("files").jsonArray.map { item ->
                JsonObject(item.jsonObject + ("header" to JsonPrimitive(headerHex)))
            }
            return JsonObject(obj + ("files" to JsonArray(files)))
        }
        val patched = patch(document)
        val rebuilt = JsonObject(patched + (entryId.toString() to patch(patched.getValue(entryId.toString()).jsonObject)))
        manifestFile.writeText(prettyPrint(rebuilt) + "\n")
    }

    @Test
    fun `validateUser normalizes uppercase hex and rejects bad input`() {
        assertEquals("abcdef12", Metadata.validateUser("ABCDEF12", "user"))
        assertEquals("138c0dbf", Metadata.validateUser("138c0dbf", "user"))
        assertThrows(DtException::class.java) { Metadata.validateUser("abcdef1", "user") }
        assertThrows(DtException::class.java) { Metadata.validateUser("abcdef123", "user") }
        assertThrows(DtException::class.java) { Metadata.validateUser("zzzzzzzz", "user") }
        assertThrows(DtException::class.java) { Metadata.validateUser("abcdef12", "") }
        assertThrows(DtException::class.java) { Metadata.validateUser("abcdef12", "a\u0000b") }
    }

    @Test
    fun `inferTitleId finds the segment after the savedata marker`() {
        assertEquals("PPSA01289", Metadata.inferTitleId(listOf("/user/home/138c0dbf/savedata_prospero/ppsa01289/save.bin")))
        assertEquals("CUSA12345", Metadata.inferTitleId(listOf("/user/home/138c0dbf/savedata/CUSA12345/save.bin")))
        assertEquals(
            "PPSA01289",
            Metadata.inferTitleId(listOf("/no/marker/here", "/user/home/138c0dbf/savedata_prospero/PPSA01289/s.bin")),
        )
        assertThrows(DtException::class.java) { Metadata.inferTitleId(listOf("/user/home/138c0dbf/other/")) }
        assertThrows(DtException::class.java) { Metadata.inferTitleId(listOf("/user/savedata_prospero/short/")) }
    }

    @Test
    fun `backupSize counts only backup files`() {
        val files = listOf(
            PayloadFile("/p/save.bin", "save.bin", 8, "", ""),
            PayloadFile("/p/sdimg_sce_bu_save", "sdimg_sce_bu_save", 10, "", ""),
            PayloadFile("/p/sce_bu_save.bin", "sce_bu_save.bin", 2, "", ""),
            PayloadFile("/p/sce_bu_other", "sce_bu_other", 4, "", ""),
        )
        assertEquals(12L, Metadata.backupSize(files))
        assertEquals(24L, files.sumOf { it.size })
    }

    @Test
    fun `same user same size edit is allowed`() {
        val (assets, source) = makeCase()
        File(assets, "$entryId/save.bin").writeBytes("abcdefgh".toByteArray())
        val output = generate(assets, source)
        assertTrue(output.isFile)
        assertTrue(File(root, "generated-manifest.json").isFile)
    }

    @Test
    fun `same size edit regenerates manifest hash`() {
        val (assets, source) = makeCase()
        val payload = "abcdefgh".toByteArray()
        File(assets, "$entryId/save.bin").writeBytes(payload)
        generate(assets, source)
        val item = generatedManifestItem()
        assertEquals(8L, item.getValue("size").jsonPrimitive.long)
        assertEquals(sha256Hex(payload), item.getValue("sha256").jsonPrimitive.content)
    }

    @Test
    fun `cross user upload is allowed`() {
        val (assets, source) = makeCase()
        val output = generate(assets, source, user = "18c60eaa")
        withDb(output) { db ->
            val path = db.queryOne("SELECT path FROM dir_entry_info_tbl") { it.getString(0) }
            val owner = db.queryOne("SELECT user_id FROM user_info_tbl") { it.getLong(0) }
            assertEquals("/user/home/18c60eaa/savedata_prospero/$titleId/", path)
            assertEquals("18c60eaa".toLong(16), owner)
        }
    }

    @Test
    fun `resized file regenerates manifest and metadata`() {
        val (assets, source) = makeCase()
        val payload = "123456789".toByteArray()
        File(assets, "$entryId/save.bin").writeBytes(payload)
        val output = generate(assets, source)
        val item = generatedManifestItem()
        assertEquals(9L, item.getValue("size").jsonPrimitive.long)
        assertEquals(sha256Hex(payload), item.getValue("sha256").jsonPrimitive.content)
        assertEquals(9L, leReader(item.getValue("header").jsonPrimitive.content.hexToBytes()).getLong(240))
        withDb(output) { db ->
            val sizes = db.queryOne("SELECT actual_size, transfer_size, required_size FROM dir_entry_info_tbl") {
                Triple(it.getLong(0), it.getLong(1), it.getLong(2))
            }
            val savedataSize = db.queryOne("SELECT size FROM users_savedata_tbl") { it.getLong(0) }
            assertEquals(Triple(9L, 9L, 9L), sizes)
            assertEquals(9L, savedataSize)
        }
    }

    @Test
    fun `stale header size is regenerated`() {
        val (assets, source) = makeCase()
        val manifestFile = File(assets, "manifest.json")
        val patched = Gfp5.patchSize(manifestItemHeader(manifestFile), 9)
        rewriteManifestHeader(manifestFile, patched.toHex())
        generate(assets, source)
        val item = generatedManifestItem()
        assertEquals(8L, item.getValue("size").jsonPrimitive.long)
        assertEquals(8L, leReader(item.getValue("header").jsonPrimitive.content.hexToBytes()).getLong(240))
    }

    @Test
    fun `header path mismatch is rejected`() {
        val (assets, source) = makeCase()
        val manifestFile = File(assets, "manifest.json")
        val header = manifestItemHeader(manifestFile)
        java.util.Arrays.fill(header, 276, 1300, 0.toByte())
        rewriteManifestHeader(manifestFile, header.toHex())
        val error = assertThrows(DtException::class.java) { generate(assets, source) }
        assertTrue(error.message!!.contains("mismatched manifest and GFP5 paths"))
    }

    @Test
    fun `regional mismatch uses the payload title and size`() {
        val (assets, source) = makeCase()
        val payloadPath = "/user/home/$userId/savedata_prospero/$titleId/"
        withDb(source) { db ->
            db.update(
                "UPDATE dir_entry_info_tbl SET path = ?, actual_size = 16, transfer_size = 16, required_size = 16 WHERE id = ?",
                "/user/home/$userId/savedata_prospero/PPSA00000/", entryId,
            )
            db.update("INSERT INTO dir_entry_info_tbl VALUES (122, ?, 1, 3, 0, '', '', 8, 8, 8, 0)", payloadPath)
        }
        File(assets, "$entryId/save.bin").writeBytes("123456789".toByteArray())
        val output = generate(assets, source)
        withDb(output) { db ->
            val row = db.queryOne("SELECT id, path, actual_size, transfer_size, required_size FROM dir_entry_info_tbl") {
                listOf(it.getLong(0), it.getString(1), it.getLong(2), it.getLong(3), it.getLong(4))
            }
            assertEquals(listOf(entryId, payloadPath, 9L, 9L, 9L), row)
            val titles = db.query("SELECT title_id, size FROM users_savedata_tbl") { it.getString(0) to it.getLong(1) }
            assertEquals(listOf(titleId to 9L), titles)
        }
    }

    @Test
    fun `no backup files have zero bu size`() {
        val (assets, source) = makeCase()
        val output = Metadata.createMetadata(
            JdbcSqlDb.Factory, File(root, "single.db"), userId, titleId, entryId, assets, "test-user",
            sourceMetadata = source,
        )
        withDb(output) { db ->
            assertEquals(0L, db.queryOne("SELECT bu_size FROM users_savedata_tbl") { it.getLong(0) })
        }
    }

    @Test
    fun `backup size counts only backup files in generated metadata`() {
        val payloads = listOf(
            "save.bin" to "12345678".toByteArray(),
            "sdimg_sce_bu_save" to "0123456789".toByteArray(),
            "sce_bu_save.bin" to "ab".toByteArray(),
        )
        val assets = saveCase(root, userId, entryId, titleId, payloads)
        val source = sourceDb(root, userId)
        val single = Metadata.createMetadata(
            JdbcSqlDb.Factory, File(root, "single.db"), userId, titleId, entryId, assets, "test-user",
            sourceMetadata = source,
        )
        val filtered = generate(assets, source)
        for (output in listOf(single, filtered)) {
            withDb(output) { db ->
                assertEquals(
                    20L to 12L,
                    db.queryOne("SELECT size, bu_size FROM users_savedata_tbl") { it.getLong(0) to it.getLong(1) },
                )
            }
        }
    }

    @Test
    fun `loadManifest requires a manifest file`() {
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(File(root, "nope")) }
        assertTrue(error.message!!.contains("save manifest not found"))
    }

    @Test
    fun `loadManifest rejects an empty manifest`() {
        val assets = File(root, "assets").apply { mkdirs() }
        File(assets, "manifest.json").writeText("{}")
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(assets) }
        assertTrue(error.message!!.contains("no downloaded saves"))
    }

    @Test
    fun `loadManifest requires an unambiguous entry`() {
        val assets = File(root, "assets").apply { mkdirs() }
        File(assets, "manifest.json").writeText("""{"137": {}, "138": {}}""")
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(assets) }
        assertTrue(error.message!!.contains("select the save entries to upload"))
    }

    @Test
    fun `loadManifest rejects a missing payload file`() {
        val assets = saveCase(root, userId, entryId, titleId, listOf("save.bin" to "12345678".toByteArray()))
        File(assets, "$entryId/save.bin").delete()
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(assets) }
        assertTrue(error.message!!.contains("is missing"))
    }

    private fun brokenCase(name: String, header: ByteArray, finalHeader: ByteArray = Gfp5.finalHeader(entryId)): File {
        val dir = File(root, name)
        val assets = File(dir, "assets")
        val entryDir = File(assets, entryId.toString())
        entryDir.mkdirs()
        File(entryDir, "save.bin").writeBytes("12345678".toByteArray())
        val manifest = EntryManifest(entryId, mutableListOf(PayloadFile(savePath, "save.bin", 8, "stale", header.toHex())), finalHeader.toHex())
        File(assets, "manifest.json").writeText(manifest.toJson() + "\n")
        return assets
    }

    @Test
    fun `loadManifest rejects a bad payload magic`() {
        val header = Gfp5.build(entryId, 8, savePath)
        header[0] = 0
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(brokenCase("badmagic", header)) }
        assertTrue(error.message!!.contains("invalid GFP5 header"))
    }

    @Test
    fun `loadManifest rejects a mismatched payload entry id`() {
        val header = Gfp5.build(138, 8, savePath)
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(brokenCase("wrongid", header)) }
        assertTrue(error.message!!.contains("mismatched GFP5 entry ID"))
    }

    @Test
    fun `loadManifest rejects a mismatched header path`() {
        val header = Gfp5.build(entryId, 8, "/user/home/$userId/savedata_prospero/$titleId/other.bin")
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(brokenCase("wrongpath", header)) }
        assertTrue(error.message!!.contains("mismatched manifest and GFP5 paths"))
    }

    @Test
    fun `loadManifest rejects a non basename filename`() {
        val dir = File(root, "nested")
        val assets = File(dir, "assets")
        val entryDir = File(assets, entryId.toString())
        entryDir.mkdirs()
        File(entryDir, "save.bin").writeBytes("12345678".toByteArray())
        val manifest = EntryManifest(
            entryId,
            mutableListOf(PayloadFile(savePath, "sub/save.bin", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())),
            Gfp5.finalHeader(entryId).toHex(),
        )
        File(assets, "manifest.json").writeText(manifest.toJson() + "\n")
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(assets) }
        assertTrue(error.message!!.contains("invalid save filename"))
    }

    @Test
    fun `loadManifest rejects a missing file header`() {
        val dir = File(root, "noheader")
        val assets = File(dir, "assets")
        val entryDir = File(assets, entryId.toString())
        entryDir.mkdirs()
        File(entryDir, "save.bin").writeBytes("12345678".toByteArray())
        val manifest = EntryManifest(
            entryId,
            mutableListOf(PayloadFile(savePath, "save.bin", 8, "stale", "")),
            Gfp5.finalHeader(entryId).toHex(),
        )
        File(assets, "manifest.json").writeText(manifest.toJson() + "\n")
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(assets) }
        assertTrue(error.message!!.contains("lacks its GFP5 header"))
    }

    @Test
    fun `loadManifest rejects a missing final header`() {
        val dir = File(root, "nofinal")
        val assets = File(dir, "assets")
        val entryDir = File(assets, entryId.toString())
        entryDir.mkdirs()
        File(entryDir, "save.bin").writeBytes("12345678".toByteArray())
        val item = PayloadFile(savePath, "save.bin", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())
        val document = JsonObject(
            linkedMapOf(
                "entry_id" to JsonPrimitive(entryId),
                "files" to JsonArray(listOf(itemJson(item))),
                entryId.toString() to JsonObject(linkedMapOf("files" to JsonArray(listOf(itemJson(item))))),
            )
        )
        File(assets, "manifest.json").writeText(prettyPrint(document) + "\n")
        val error = assertThrows(DtException::class.java) { Metadata.loadManifest(assets) }
        assertTrue(error.message!!.contains("lacks a GFP5 final header"))
    }

    @Test
    fun `loadManifest rejects a bad final header`() {
        val header = Gfp5.build(entryId, 8, savePath)
        val badMagic = Gfp5.finalHeader(entryId)
        badMagic[0] = 0
        var error = assertThrows(DtException::class.java) { Metadata.loadManifest(brokenCase("badfinal", header, badMagic)) }
        assertTrue(error.message!!.contains("invalid GFP5 final header"))
        error = assertThrows(DtException::class.java) {
            Metadata.loadManifest(brokenCase("wrongfinal", header, Gfp5.finalHeader(138)))
        }
        assertTrue(error.message!!.contains("mismatched GFP5 final header"))
        val notFinal = Gfp5.finalHeader(entryId)
        notFinal[274] = 0
        error = assertThrows(DtException::class.java) { Metadata.loadManifest(brokenCase("notfinal", header, notFinal)) }
        assertTrue(error.message!!.contains("mismatched GFP5 final header"))
    }

    @Test
    fun `validatePayload patches sizes and recomputes the hash`() {
        val payload = "123456789".toByteArray()
        val file = File(root, "save.bin").apply { writeBytes(payload) }
        val item = PayloadFile(savePath, "save.bin", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())
        Metadata.validatePayload(file, entryId, item)
        assertEquals(9L, item.size)
        assertEquals(sha256Hex(payload), item.sha256)
        val header = item.header.hexToBytes()
        assertEquals(9L, leReader(header).getLong(0x20))
        assertEquals(9L, leReader(header).getLong(0xF0))
    }

    @Test
    fun `validatePayload accepts same size content edits`() {
        val payload = "abcdefgh".toByteArray()
        val file = File(root, "save.bin").apply { writeBytes(payload) }
        val item = PayloadFile(savePath, "save.bin", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())
        Metadata.validatePayload(file, entryId, item)
        assertEquals(8L, item.size)
        assertEquals(sha256Hex(payload), item.sha256)
    }

    @Test
    fun `validatePayload rejects empty files and path mismatches`() {
        val empty = File(root, "empty.bin").apply { writeBytes(ByteArray(0)) }
        var item = PayloadFile(savePath, "empty.bin", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())
        var error = assertThrows(DtException::class.java) { Metadata.validatePayload(empty, entryId, item) }
        assertTrue(error.message!!.contains("is empty"))
        val file = File(root, "save.bin").apply { writeBytes("12345678".toByteArray()) }
        item = PayloadFile("/user/home/other/path.bin", "save.bin", 8, "stale", Gfp5.build(entryId, 8, savePath).toHex())
        error = assertThrows(DtException::class.java) { Metadata.validatePayload(file, entryId, item) }
        assertTrue(error.message!!.contains("mismatched manifest and GFP5 paths"))
    }

    @Test
    fun `createMetadata from the bundled template writes the expected rows`() {
        val assets = saveCase(root, userId, entryId, titleId, listOf("save.bin" to "12345678".toByteArray()))
        val output = Metadata.createMetadata(
            JdbcSqlDb.Factory, File(root, "single.db"), userId, titleId, entryId, assets, "test-user",
        )
        assertTrue(File(root, "single.manifest.json").isFile)
        withDb(output) { db ->
            val user = db.queryOne(
                "SELECT user_id, user_name, npenv, online_user, target_owner, target_user_id, savedata_auto_upload, savedata_auto_sync FROM user_info_tbl"
            ) {
                listOf(it.getLong(0), it.getString(1), it.getString(2), it.getLong(3), it.getLong(4), it.getLong(5), it.getLong(6), it.getLong(7))
            }
            assertEquals(listOf(userId.toLong(16), "test-user", "np", 1L, 1L, 0L, 1L, 1L), user)
            val dir = db.queryOne(
                "SELECT id, path, partition, target_type, target_subtype, title_id, content_id, actual_size, transfer_size, required_size, required_zone_size FROM dir_entry_info_tbl"
            ) {
                listOf(
                    it.getLong(0), it.getString(1), it.getLong(2), it.getLong(3), it.getLong(4), it.getString(5),
                    it.getString(6), it.getLong(7), it.getLong(8), it.getLong(9), it.getLong(10),
                )
            }
            assertEquals(
                listOf(entryId, "/user/home/$userId/savedata_prospero/$titleId/", 1L, 3L, 0L, "", "", 8L, 8L, 8L, 0L),
                dir,
            )
            val savedata = db.queryOne(
                "SELECT user_id, title_id, path_to_title_id, size, bu_size, format_type, upload_setting, already_exists FROM users_savedata_tbl"
            ) {
                listOf(it.getLong(0), it.getString(1), it.getString(2), it.getLong(3), it.getLong(4), it.getLong(5), it.getLong(6), it.getLong(7))
            }
            assertEquals(listOf(userId.toLong(16), titleId, titleId, 8L, 0L, 1L, 1L, 0L), savedata)
        }
        val manifest = Json.parseToJsonElement(File(root, "single.manifest.json").readText()).jsonObject
        assertTrue(manifest.containsKey(entryId.toString()))
        assertEquals(8L, manifest.getValue(entryId.toString()).jsonObject.getValue("files").jsonArray[0].jsonObject.getValue("size").jsonPrimitive.long)
    }

    @Test
    fun `createMetadata copies the source user with forced transfer fields`() {
        val assets = saveCase(root, userId, entryId, titleId, listOf("save.bin" to "12345678".toByteArray()))
        val source = sourceDb(root, userId)
        val output = Metadata.createMetadata(
            JdbcSqlDb.Factory, File(root, "single.db"), userId, titleId, entryId, assets, "whoever",
            sourceMetadata = source,
        )
        withDb(output) { db ->
            val user = db.queryOne(
                "SELECT user_name, login_id, online_id, npenv, online_user, target_owner, target_user_id, uuid, savedata_auto_upload, savedata_auto_sync FROM user_info_tbl"
            ) {
                listOf(
                    it.getString(0), it.getString(1), it.getString(2), it.getString(3), it.getLong(4),
                    it.getLong(5), it.getLong(6), it.getString(7), it.getLong(8), it.getLong(9),
                )
            }
            assertEquals(
                listOf("earthonion", "myanraddox@gmail.com", "earthonion", "np", 1L, 1L, 0L, "3e338f700e51db91", 1L, 1L),
                user,
            )
        }
    }

    @Test
    fun `createFilteredMetadata requires a distinct output`() {
        val (assets, source) = makeCase()
        val error = assertThrows(DtException::class.java) {
            Metadata.createFilteredMetadata(JdbcSqlDb.Factory, source, source, userId, "test-user", listOf(entryId), assets)
        }
        assertTrue(error.message!!.contains("must differ from the source"))
    }

    @Test
    fun `createFilteredMetadata rejects entries absent from the source`() {
        val (assets, source) = makeCase()
        val extraDir = File(assets, "200")
        extraDir.mkdirs()
        File(extraDir, "save.bin").writeBytes("12345678".toByteArray())
        val extra = EntryManifest(
            200,
            mutableListOf(payloadItem(200, "/user/home/$userId/savedata_prospero/$titleId/save.bin", "save.bin", 8)),
            Gfp5.finalHeader(200).toHex(),
        )
        File(extraDir, "manifest.json").writeText(extra.toJson() + "\n")
        val rootManifest = File(assets, "manifest.json")
        val document = Json.parseToJsonElement(rootManifest.readText()).jsonObject
        val extraJson = Json.parseToJsonElement(extra.toJson()).jsonObject.getValue("200")
        rootManifest.writeText(prettyPrint(JsonObject(document + ("200" to extraJson))) + "\n")
        val error = assertThrows(DtException::class.java) {
            Metadata.createFilteredMetadata(
                JdbcSqlDb.Factory, File(root, "filtered.db"), source, userId, "test-user", listOf(entryId, 200), assets,
            )
        }
        assertTrue(error.message!!.contains("absent from the source metadata"))
    }

    @Test
    fun `createFilteredMetadata enforces save target types`() {
        val (assets, source) = makeCase()
        withDb(source) { db -> db.update("UPDATE dir_entry_info_tbl SET target_type = 1 WHERE id = ?", entryId) }
        val error = assertThrows(DtException::class.java) {
            Metadata.createFilteredMetadata(
                JdbcSqlDb.Factory, File(root, "filtered.db"), source, userId, "test-user", listOf(entryId), assets,
            )
        }
        assertTrue(error.message!!.contains("absent from the source metadata"))
    }

    @Test
    fun `syncUploadMetadata resizes the entry and enforces the row count`() {
        val (assets, source) = makeCase()
        val output = generate(assets, source)
        val files = listOf(PayloadFile(savePath, "save.bin", 9, "", ""))
        withDb(output) { db ->
            Metadata.syncUploadMetadata(db, entryId, titleId, files)
            val sizes = db.queryOne("SELECT actual_size, transfer_size, required_size FROM dir_entry_info_tbl") {
                Triple(it.getLong(0), it.getLong(1), it.getLong(2))
            }
            assertEquals(Triple(9L, 9L, 9L), sizes)
            assertEquals(
                9L to 0L,
                db.queryOne("SELECT size, bu_size FROM users_savedata_tbl") { it.getLong(0) to it.getLong(1) },
            )
            val error = assertThrows(DtException::class.java) { Metadata.syncUploadMetadata(db, 999, titleId, files) }
            assertTrue(error.message!!.contains("metadata entry 999 is missing for upload"))
        }
    }

    private fun otherDb(path: File): File {
        withDb(path) { db ->
            db.exec(
                "CREATE TABLE dir_entry_info_tbl (id, path, partition, target_type, target_subtype, " +
                    "title_id, content_id, actual_size, transfer_size, required_size, required_zone_size)"
            )
            db.update("INSERT INTO dir_entry_info_tbl VALUES (296, ?, 1, 1, 0, '', '', 8, 8, 8, 0)", "/user/app/PPSA05688/")
        }
        return path
    }

    @Test
    fun `syncOtherMetadata updates sizes for non save entries`() {
        withDb(otherDb(File(root, "other.db"))) { db ->
            val files = listOf(PayloadFile("/user/app/PPSA05688/app.pkg", "app.pkg", 16, "", ""))
            Metadata.syncOtherMetadata(db, 296, files)
            val sizes = db.queryOne("SELECT actual_size, transfer_size, required_size FROM dir_entry_info_tbl") {
                Triple(it.getLong(0), it.getLong(1), it.getLong(2))
            }
            assertEquals(Triple(16L, 16L, 16L), sizes)
        }
    }

    @Test
    fun `syncOtherMetadata rejects saves stray paths and missing entries`() {
        withDb(otherDb(File(root, "other.db"))) { db ->
            val files = listOf(PayloadFile("/user/app/PPSA05688/app.pkg", "app.pkg", 8, "", ""))
            var error = assertThrows(DtException::class.java) { Metadata.syncOtherMetadata(db, 999, files) }
            assertTrue(error.message!!.contains("metadata entry 999 is missing for upload"))
            val stray = listOf(PayloadFile("/user/other/app.pkg", "app.pkg", 8, "", ""))
            error = assertThrows(DtException::class.java) { Metadata.syncOtherMetadata(db, 296, stray) }
            assertTrue(error.message!!.contains("payload path outside"))
            db.update("UPDATE dir_entry_info_tbl SET target_type = 3 WHERE id = 296")
            error = assertThrows(DtException::class.java) { Metadata.syncOtherMetadata(db, 296, files) }
            assertTrue(error.message!!.contains("savedata entries require savedata metadata generation"))
        }
    }

    @Test
    fun `createOtherMetadata refreshes sizes from the payload`() {
        val assets = File(root, "assets")
        val entryDir = File(assets, "296")
        entryDir.mkdirs()
        val payload = "pkg-data!".toByteArray()
        File(entryDir, "app.pkg").writeBytes(payload)
        val path = "/user/app/PPSA05688/app.pkg"
        val manifest = EntryManifest(
            296,
            mutableListOf(PayloadFile(path, "app.pkg", 8, "stale", Gfp5.build(296, 8, path).toHex())),
            Gfp5.finalHeader(296).toHex(),
        )
        File(entryDir, "manifest.json").writeText(manifest.toJson() + "\n")
        val source = otherDb(File(root, "source.db"))
        val output = File(root, "generated.db")
        val manifestOutput = File(root, "generated.json")
        Metadata.createOtherMetadata(JdbcSqlDb.Factory, output, source, userId, "test-user", listOf(296), assets, manifestOutput)
        withDb(output) { db ->
            val sizes = db.queryOne("SELECT actual_size, transfer_size, required_size FROM dir_entry_info_tbl") {
                Triple(it.getLong(0), it.getLong(1), it.getLong(2))
            }
            assertEquals(Triple(9L, 9L, 9L), sizes)
        }
        val generated = Json.parseToJsonElement(manifestOutput.readText()).jsonObject
        assertEquals(9L, generated.getValue("296").jsonObject.getValue("files").jsonArray[0].jsonObject.getValue("size").jsonPrimitive.long)
    }

    @Test
    fun `createOtherMetadata requires entries and a distinct output`() {
        val source = otherDb(File(root, "source.db"))
        var error = assertThrows(DtException::class.java) {
            Metadata.createOtherMetadata(
                JdbcSqlDb.Factory, File(root, "generated.db"), source, userId, "test-user", emptyList(), File(root, "assets"),
            )
        }
        assertTrue(error.message!!.contains("select at least one non-save entry"))
        error = assertThrows(DtException::class.java) {
            Metadata.createOtherMetadata(
                JdbcSqlDb.Factory, source, source, userId, "test-user", listOf(296), File(root, "assets"),
            )
        }
        assertTrue(error.message!!.contains("must differ from the source"))
    }
}

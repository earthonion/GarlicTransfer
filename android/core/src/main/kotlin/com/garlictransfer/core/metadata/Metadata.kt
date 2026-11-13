package com.garlictransfer.core.metadata

import com.garlictransfer.core.ConsoleUser
import com.garlictransfer.core.DtException
import com.garlictransfer.core.EntryKind
import com.garlictransfer.core.SaveEntry
import com.garlictransfer.core.gfp5.GFP5_HEADER_SIZE
import com.garlictransfer.core.gfp5.GFP5_MAGIC
import com.garlictransfer.core.gfp5.GFP5_MODE_REGULAR
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.toHex
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

const val EXTERNAL_SAVE_ENTRY_ID: Long = 0x10000

internal data class DirEntryRow(
    val id: Long,
    val path: String,
    val partition: Long,
    val targetType: Long,
    val targetSubtype: Long,
    val titleId: String?,
    val contentId: String?,
    val actualSize: Long,
    val transferSize: Long,
    val requiredSize: Long,
    val requiredZoneSize: Long,
) {
    fun bindValues(): Array<Any?> = arrayOf(
        id, path, partition, targetType, targetSubtype, titleId, contentId,
        actualSize, transferSize, requiredSize, requiredZoneSize,
    )
}

internal data class UserRow(
    val userId: Long,
    val userName: String?,
    val trophySync: Long,
    val accountId: Long?,
    val loginId: String?,
    val onlineId: String?,
    val avatar: String?,
    val npenv: String?,
    val onlineUser: Long,
    val targetOwner: Long,
    val targetUserId: Long,
    val uuid: String?,
    val savedataAutoUpload: Long,
    val savedataAutoSync: Long,
) {
    fun bindValues(): Array<Any?> = arrayOf(
        userId, userName, trophySync, accountId, loginId, onlineId, avatar, npenv,
        onlineUser, targetOwner, targetUserId, uuid, savedataAutoUpload, savedataAutoSync,
    )
}

internal data class SavedataRow(
    val userId: Long,
    val titleId: String,
    val pathToTitleId: String,
    val size: Long,
    val buSize: Long,
    val formatType: Long,
    val uploadSetting: Long,
    val alreadyExists: Long,
    val lastModifiedTime: Long,
)

private data class InventoryRow(val id: Long, val path: String, val size: Long, val targetType: Long)

/**
 * SQLite metadata generation and safety rules. Port of poc/dt_metadata.py:
 * all size/hash/header data is revalidated against the payload on disk before use.
 */
object Metadata {

    private val USER_ID_REGEX = Regex("[0-9a-fA-F]{8}")
    private val TITLE_ID_REGEX = Regex("[A-Za-z0-9]{9}")
    private val STRICT_TITLE_ID_REGEX = Regex("[A-Z0-9]{9}")
    private val TITLE_MARKERS = listOf("savedata_prospero", "savedata")

    /** Validates and returns the normalized (lowercase, 8-hex-digit) user id. */
    fun validateUser(userId: String, userName: String): String {
        if (!USER_ID_REGEX.matches(userId)) throw DtException("user ID must be exactly 8 hexadecimal digits")
        if (userName.isEmpty() || '\u0000' in userName) throw DtException("user name is required")
        return userId.lowercase()
    }

    fun inferTitleId(paths: List<String>): String {
        for (path in paths) {
            val parts = path.trim('/').split('/')
            for (marker in TITLE_MARKERS) {
                val index = parts.indexOf(marker)
                if (index >= 0 && index + 1 < parts.size && TITLE_ID_REGEX.matches(parts[index + 1])) {
                    return parts[index + 1].uppercase()
                }
            }
        }
        throw DtException("title ID must be exactly 9 letters or digits")
    }

    fun backupSize(files: List<PayloadFile>): Long = files
        .filter { it.file.startsWith("sdimg_sce_bu_") || (it.file.startsWith("sce_bu_") && it.file.endsWith(".bin")) }
        .sumOf { it.size }

    /** Locates and validates a manifest under [assets]; refreshes size/sha256/header of every file from disk. */
    fun loadManifest(assets: File, entryId: Long? = null, expectedUserId: String? = null): Pair<Long, EntryManifest> {
        var manifestPath = File(assets, "manifest.json")
        if (!manifestPath.isFile && entryId != null) {
            manifestPath = File(assets, "$entryId/manifest.json")
        }
        if (!manifestPath.isFile) throw DtException("save manifest not found under $assets")
        val root = parseJsonObjectFile(manifestPath)
        if (root.isEmpty()) throw DtException("no downloaded saves were found; download save data before uploading")
        val id: Long = entryId ?: run {
            (root["entry_id"] as? JsonPrimitive)?.longOrNull?.let { return@run it }
            val numericKeys = root.keys.filter { key -> key.isNotEmpty() && key.all(Char::isDigit) }
            if (numericKeys.size != 1) {
                throw DtException("select the save entries to upload; the manifest contains multiple saves")
            }
            numericKeys[0].toLong()
        }
        val entryObject = root[id.toString()] as? JsonObject
        val filesArray = (entryObject?.get("files") ?: root["files"]) as? JsonArray
        if (filesArray.isNullOrEmpty()) throw DtException("save manifest for entry $id contains no files")
        val finalHeader = (entryObject?.get("final_header") as? JsonPrimitive)?.contentOrNull
        if (finalHeader.isNullOrEmpty()) {
            throw DtException("entry $id lacks a GFP5 final header; redownload it with this version")
        }
        val files = filesArray.map { element ->
            val item = element as? JsonObject ?: throw DtException("entry $id has an invalid save filename")
            val rawName = (item["file"] as? JsonPrimitive)?.contentOrNull ?: ""
            val name = File(rawName).name
            if (name.isEmpty() || name != rawName) throw DtException("entry $id has an invalid save filename")
            val path = listOf(File(assets, "$id/$name"), File(assets, name)).firstOrNull { it.isFile }
                ?: throw DtException("save file for entry $id is missing: $name")
            val header = (item["header"] as? JsonPrimitive)?.contentOrNull
            if (header.isNullOrEmpty()) throw DtException("save file $name lacks its GFP5 header; redownload the save")
            val payload = PayloadFile(
                path = (item["path"] as? JsonPrimitive)?.contentOrNull ?: "",
                file = rawName,
                size = (item["size"] as? JsonPrimitive)?.longOrNull ?: 0,
                sha256 = (item["sha256"] as? JsonPrimitive)?.contentOrNull ?: "",
                header = header,
            )
            validatePayload(path, id, payload)
            payload
        }.toMutableList()
        val finalBytes = try {
            finalHeader.hexToBytes()
        } catch (e: IllegalArgumentException) {
            throw DtException("entry $id has an invalid GFP5 final header", e)
        }
        if (finalBytes.size != GFP5_HEADER_SIZE || gfp5Magic(finalBytes) != GFP5_MAGIC) {
            throw DtException("entry $id has an invalid GFP5 final header")
        }
        if (gfp5EntryId(finalBytes) != id || finalBytes[274].toInt() == 0) {
            throw DtException("entry $id has a mismatched GFP5 final header")
        }
        return Pair(id, EntryManifest(id, files, finalHeader))
    }

    /** Revalidates one payload file; patches GFP5 sizes and recomputes SHA-256 when the disk file changed. */
    fun validatePayload(file: File, entryId: Long, item: PayloadFile) {
        val header = try {
            item.header.hexToBytes()
        } catch (e: IllegalArgumentException) {
            throw DtException("save file ${item.file} has an invalid GFP5 header", e)
        }
        if (header.size != GFP5_HEADER_SIZE || gfp5Magic(header) != GFP5_MAGIC) {
            throw DtException("save file ${item.file} has an invalid GFP5 header")
        }
        if (gfp5EntryId(header) != entryId) throw DtException("save file ${item.file} has a mismatched GFP5 entry ID")
        val headerPath = try {
            gfp5Path(header)
        } catch (e: CharacterCodingException) {
            throw DtException("save file ${item.file} has mismatched manifest and GFP5 paths", e)
        }
        if (headerPath != item.path) throw DtException("save file ${item.file} has mismatched manifest and GFP5 paths")
        if (!file.isFile) throw DtException("save file ${item.file} is missing")
        val actualSize = file.length()
        if (actualSize <= 0) throw DtException("save file ${item.file} is empty")
        item.header = Gfp5.patchSize(header, actualSize).toHex()
        item.size = actualSize
        item.sha256 = sha256Hex(file)
    }

    fun createMetadata(
        dbFactory: SqlDbFactory,
        output: File,
        userId: String,
        titleId: String,
        entryId: Long,
        assets: File,
        userName: String,
        manifestOutput: File? = null,
        sourceMetadata: File? = null,
    ): File {
        val normalizedUser = validateUser(userId, userName)
        val targetUser = sourceMetadata?.let { findDownloadedUser(dbFactory, it, normalizedUser) }
        val (resolvedId, uploadEntry) = loadManifest(assets, entryId, expectedUserId = normalizedUser)
        val files = uploadEntry.files
        val title = if (titleId.isNotEmpty()) titleId.uppercase() else inferTitleId(files.map { it.path })
        if (!STRICT_TITLE_ID_REGEX.matches(title)) throw DtException("title ID must be exactly 9 letters or digits")
        val totalSize = files.sumOf { it.size }
        val buSize = backupSize(files)
        if (totalSize <= 0) throw DtException("save files must not be empty")
        output.parentFile?.mkdirs()
        if (sourceMetadata != null) {
            sourceMetadata.copyTo(output, overwrite = true)
        } else {
            val templateDir = Files.createTempDirectory("garlic-template").toFile()
            MetadataTemplates.singleSaveDb(templateDir).copyTo(output, overwrite = true)
        }
        val db = dbFactory.open(output)
        try {
            db.exec("DELETE FROM user_info_tbl")
            db.exec("DELETE FROM users_savedata_tbl")
            db.exec("DELETE FROM dir_entry_info_tbl")
            db.exec("DELETE FROM app_info_tbl")
            db.exec("DELETE FROM app_service_ac_tbl")
            db.exec("DELETE FROM app_service_fgc_tbl")
            db.exec("DELETE FROM capture_info_tbl")
            insertUser(db, normalizedUser, userName, targetUser)
            db.update(
                "INSERT INTO users_savedata_tbl VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?)",
                normalizedUser.toLong(16), title, title, totalSize, buSize, System.currentTimeMillis() / 1000,
            )
            db.update(
                "INSERT INTO dir_entry_info_tbl VALUES (?, ?, 1, 3, 0, '', '', ?, ?, ?, 0)",
                resolvedId, "/user/home/$normalizedUser/savedata_prospero/$title/", totalSize, totalSize, totalSize,
            )
        } finally {
            db.close()
        }
        writeUploadManifest(manifestOutput ?: manifestSibling(output), mapOf(resolvedId to uploadEntry))
        return output
    }

    fun createFilteredMetadata(
        dbFactory: SqlDbFactory,
        output: File,
        sourceMetadata: File,
        userId: String,
        userName: String,
        entryIds: List<Long>,
        assets: File,
        manifestOutput: File? = null,
    ): File {
        val normalizedUser = validateUser(userId, userName)
        val requested: List<Long?> = if (entryIds.isEmpty()) listOf(null) else entryIds
        val uploadEntries = LinkedHashMap<Long, EntryManifest>()
        for (requestedId in requested) {
            val (actualId, entry) = loadManifest(assets, requestedId, expectedUserId = normalizedUser)
            uploadEntries[actualId] = entry
        }
        val sortedIds = uploadEntries.keys.sorted()
        if (output.canonicalFile == sourceMetadata.canonicalFile) {
            throw DtException("filtered metadata output must differ from the source database")
        }
        output.parentFile?.mkdirs()
        sourceMetadata.copyTo(output, overwrite = true)
        val db = dbFactory.open(output)
        try {
            val placeholders = sortedIds.joinToString(",") { "?" }
            val rows = db.query(
                "SELECT * FROM dir_entry_info_tbl WHERE target_type = 3 AND id IN ($placeholders) ORDER BY id",
                *sortedIds.toTypedArray(),
            ) { it.toDirEntryRow() }
            if (rows.mapTo(HashSet()) { it.id } != sortedIds.toSet()) {
                throw DtException("one or more selected save entries are absent from the source metadata")
            }
            val targetUser = db.queryOne("SELECT * FROM user_info_tbl WHERE user_id = ?", normalizedUser.toLong(16)) { it.toUserRow() }
            val savedataRows = db.query("SELECT * FROM users_savedata_tbl") { it.toSavedataRow() }
            val candidateRows = db.query("SELECT * FROM dir_entry_info_tbl WHERE target_type = 3") { it.toDirEntryRow() }
            db.exec("DELETE FROM dir_entry_info_tbl")
            db.exec("DELETE FROM app_info_tbl")
            db.exec("DELETE FROM app_service_ac_tbl")
            db.exec("DELETE FROM app_service_fgc_tbl")
            db.exec("DELETE FROM capture_info_tbl")
            db.exec("DELETE FROM users_savedata_tbl")
            db.exec("DELETE FROM user_info_tbl")
            insertUser(db, normalizedUser, userName, targetUser)
            val entriesByTitle = LinkedHashMap<String, MutableList<DirEntryRow>>()
            for (row in rows) {
                val (title, layout) = resolveUploadLayout(row, uploadEntries.getValue(row.id), normalizedUser, candidateRows)
                db.update("INSERT INTO dir_entry_info_tbl VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", *layout.bindValues())
                entriesByTitle.getOrPut(title) { mutableListOf() }.add(layout)
            }
            val now = System.currentTimeMillis() / 1000
            for ((title, titleRows) in entriesByTitle) {
                val original = savedataRows.firstOrNull { it.titleId.uppercase() == title }
                val totalSize = titleRows.sumOf { it.actualSize }
                val buSize = backupSize(titleRows.flatMap { uploadEntries.getValue(it.id).files })
                db.update(
                    "INSERT INTO users_savedata_tbl VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    normalizedUser.toLong(16), title, title, totalSize, buSize,
                    original?.formatType ?: 1L,
                    original?.uploadSetting ?: 1L,
                    original?.alreadyExists ?: 0L,
                    original?.lastModifiedTime ?: now,
                )
            }
        } finally {
            db.close()
        }
        writeUploadManifest(manifestOutput ?: manifestSibling(output), uploadEntries)
        return output
    }

    fun createOtherMetadata(
        dbFactory: SqlDbFactory,
        output: File,
        sourceMetadata: File,
        userId: String,
        userName: String,
        entryIds: List<Long>,
        assets: File,
        manifestOutput: File? = null,
    ): File {
        if (entryIds.isEmpty()) throw DtException("select at least one non-save entry to upload")
        if (output.canonicalFile == sourceMetadata.canonicalFile) {
            throw DtException("upload metadata output must differ from the source database")
        }
        val uploadEntries = LinkedHashMap<Long, EntryManifest>()
        for (requestedId in entryIds) {
            val (actualId, entry) = loadManifest(assets, requestedId)
            uploadEntries[actualId] = entry
        }
        output.parentFile?.mkdirs()
        sourceMetadata.copyTo(output, overwrite = true)
        val db = dbFactory.open(output)
        try {
            for ((entryId, entry) in uploadEntries) {
                syncOtherMetadata(db, entryId, entry.files)
            }
        } finally {
            db.close()
        }
        writeUploadManifest(manifestOutput ?: manifestSibling(output), uploadEntries)
        return output
    }

    fun createExternalSave(
        dbFactory: SqlDbFactory,
        output: File,
        userId: String,
        titleId: String,
        imagePath: File,
        assets: File,
        userName: String,
        manifestOutput: File? = null,
        sourceMetadata: File? = null,
    ): File {
        val normalizedUser = validateUser(userId, userName)
        val title = titleId.uppercase()
        if (!STRICT_TITLE_ID_REGEX.matches(title)) throw DtException("title ID must be exactly 9 letters or digits")
        if (!imagePath.isFile || imagePath.length() <= 0) throw DtException("external save container is missing or empty")
        val entryId = EXTERNAL_SAVE_ENTRY_ID
        val entryDirectory = File(assets, entryId.toString())
        entryDirectory.mkdirs()
        val destination = File(entryDirectory, imagePath.name)
        if (imagePath.canonicalFile != destination.canonicalFile) {
            imagePath.copyTo(destination, overwrite = true)
        }
        val sourcePath = "/user/home/$normalizedUser/savedata_prospero/$title/${imagePath.name}"
        val header = Gfp5.build(entryId, destination.length(), sourcePath, mode = GFP5_MODE_REGULAR)
        val finalHeader = Gfp5.finalHeader(entryId)
        val item = PayloadFile(
            path = sourcePath,
            file = imagePath.name,
            size = destination.length(),
            sha256 = "",
            header = header.toHex(),
        )
        val manifest = EntryManifest(entryId, mutableListOf(item), finalHeader.toHex())
        File(entryDirectory, "manifest.json").writeText(manifest.toJson() + "\n")
        return createMetadata(dbFactory, output, normalizedUser, title, entryId, assets, userName, manifestOutput, sourceMetadata)
    }

    /** Send-time re-sync of dir_entry_info_tbl/users_savedata_tbl sizes with the payloads on disk. */
    fun syncUploadMetadata(db: SqlDb, entryId: Long, titleId: String, files: List<PayloadFile>) {
        val totalSize = files.sumOf { it.size }
        val buSize = backupSize(files)
        val updated = db.update(
            "UPDATE dir_entry_info_tbl SET actual_size = ?, transfer_size = ?, required_size = ? WHERE id = ?",
            totalSize, totalSize, totalSize, entryId,
        )
        if (updated != 1) throw DtException("metadata entry $entryId is missing for upload")
        db.update(
            "UPDATE users_savedata_tbl SET " +
                "size = (SELECT COALESCE(SUM(actual_size), 0) FROM dir_entry_info_tbl " +
                "WHERE target_type = 3 AND path LIKE ?), bu_size = ? WHERE title_id = ?",
            "%/savedata_prospero/$titleId/", buSize, titleId,
        )
    }

    fun syncOtherMetadata(db: SqlDb, entryId: Long, files: List<PayloadFile>) {
        val totalSize = files.sumOf { it.size }
        val row = db.queryOne("SELECT path, target_type FROM dir_entry_info_tbl WHERE id = ?", entryId) {
            Pair(it.getString(0) ?: "", it.getLong(1))
        } ?: throw DtException("metadata entry $entryId is missing for upload")
        val (sourcePath, targetType) = row
        if (targetType == 3L) throw DtException("savedata entries require savedata metadata generation")
        val prefix = sourcePath.trimEnd('/') + "/"
        for (item in files) {
            if (!item.path.startsWith(prefix)) throw DtException("entry $entryId has a payload path outside $sourcePath")
        }
        db.update(
            "UPDATE dir_entry_info_tbl SET actual_size = ?, transfer_size = ?, required_size = ? WHERE id = ?",
            totalSize, totalSize, totalSize, entryId,
        )
    }

    /** (entries, users) as shown in the UI; [downloaded] marks entries already present locally. */
    fun readInventory(db: SqlDb, downloaded: Set<Long>): Pair<List<SaveEntry>, List<ConsoleUser>> {
        val rows = db.query("SELECT id, path, actual_size, target_type FROM dir_entry_info_tbl ORDER BY id") {
            InventoryRow(it.getLong(0), it.getString(1) ?: "", it.getLong(2), it.getLong(3))
        }
        val entries = rows.map { row ->
            val parts = row.path.trim('/').split('/')
            val kind = EntryKind.of(row.path, row.targetType.toInt())
            SaveEntry(
                id = row.id,
                title = row.path.trimEnd('/').substringAfterLast('/'),
                kind = kind,
                owner = if (kind == EntryKind.SAVE && parts.size > 2) parts[2] else "console",
                size = row.size,
                downloaded = row.id in downloaded,
            )
        }
        return Pair(entries, readUsers(db))
    }

    fun readUsers(db: SqlDb): List<ConsoleUser> =
        db.query("SELECT user_id, user_name, login_id, online_id FROM user_info_tbl ORDER BY user_name") { row ->
            val id = row.getLong(0).toString(16).padStart(8, '0')
            val name = listOf(row.getString(1), row.getString(2), row.getString(3)).firstOrNull { !it.isNullOrEmpty() } ?: id
            ConsoleUser(id = id, name = name)
        }

    internal fun resolveUploadLayout(
        row: DirEntryRow,
        uploadEntry: EntryManifest,
        userId: String,
        candidateRows: List<DirEntryRow>,
    ): Pair<String, DirEntryRow> {
        val files = uploadEntry.files
        val titleId = inferTitleId(files.map { it.path })
        val totalSize = files.sumOf { it.size }
        if (totalSize <= 0) throw DtException("save files must not be empty")
        var base = row
        val rowTitle = inferTitleId(listOf(row.path))
        if (rowTitle != titleId) {
            val matches = candidateRows.filter { candidate ->
                val parts = candidate.path.trim('/').split('/')
                if (parts.size < 3 || parts[2].lowercase() != userId) return@filter false
                inferTitleId(listOf(candidate.path)) == titleId
            }
            if (matches.size != 1) {
                throw DtException(
                    "entry ${row.id} metadata is for $rowTitle, but its save payload is for $titleId; " +
                        "no unique matching directory entry exists"
                )
            }
            base = matches[0].copy(id = row.id)
        }
        val layout = base.copy(
            path = targetPath(base.path, userId),
            actualSize = totalSize,
            transferSize = totalSize,
            requiredSize = totalSize,
        )
        return Pair(titleId, layout)
    }

    internal fun targetPath(sourcePath: String, userId: String): String {
        val parts = sourcePath.trim('/').split('/').toMutableList()
        if (parts.size < 4 || parts[0] != "user" || parts[1] != "home") {
            throw DtException("unsupported save path in metadata: $sourcePath")
        }
        parts[2] = userId
        val result = "/" + parts.joinToString("/")
        return if (sourcePath.endsWith("/")) "$result/" else result
    }

    internal fun manifestSibling(output: File): File =
        File(output.parentFile, output.name.substringBeforeLast('.', output.name) + ".manifest.json")

    internal fun writeUploadManifest(output: File, entries: Map<Long, EntryManifest>) {
        output.parentFile?.mkdirs()
        val root = JsonObject(entries.entries.associate { (id, entry) -> id.toString() to entry.toEntryJsonObject() })
        output.writeText(root.toJsonText() + "\n")
    }

    private fun findDownloadedUser(dbFactory: SqlDbFactory, sourceMetadata: File, userId: String): UserRow? {
        val db = dbFactory.open(sourceMetadata)
        try {
            return db.queryOne("SELECT * FROM user_info_tbl WHERE user_id = ?", userId.toLong(16)) { it.toUserRow() }
        } finally {
            db.close()
        }
    }

    private fun insertUser(db: SqlDb, userId: String, userName: String, targetUser: UserRow?) {
        if (targetUser != null) {
            val row = targetUser.copy(
                npenv = "np",
                onlineUser = 1,
                targetOwner = 1,
                targetUserId = 0,
                savedataAutoUpload = 1,
                savedataAutoSync = 1,
            )
            db.update("INSERT INTO user_info_tbl VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", *row.bindValues())
        } else {
            db.update(
                "INSERT INTO user_info_tbl VALUES (?, ?, 0, 0, ?, ?, '', 'np', 1, 1, 0, ?, 1, 1)",
                userId.toLong(16),
                userName,
                userName,
                userName,
                UUID.randomUUID().toString().replace("-", "").take(16),
            )
        }
    }

    private fun gfp5Magic(header: ByteArray): Long = leReader(header).getInt(0).toLong() and 0xFFFFFFFFL

    private fun gfp5EntryId(header: ByteArray): Long = leReader(header).getInt(4).toLong() and 0xFFFFFFFFL

    private fun gfp5Path(header: ByteArray): String {
        var end = 1300
        for (i in 276 until 1300) {
            if (header[i] == 0.toByte()) {
                end = i
                break
            }
        }
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return decoder.decode(ByteBuffer.wrap(header, 276, end - 276)).toString()
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream ->
            val buffer = ByteArray(0x200000)
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().toHex()
    }

    private fun SqlRow.toDirEntryRow() = DirEntryRow(
        id = getLong(0),
        path = getString(1) ?: "",
        partition = getLong(2),
        targetType = getLong(3),
        targetSubtype = getLong(4),
        titleId = getString(5),
        contentId = getString(6),
        actualSize = getLong(7),
        transferSize = getLong(8),
        requiredSize = getLong(9),
        requiredZoneSize = getLong(10),
    )

    private fun SqlRow.toUserRow() = UserRow(
        userId = getLong(0),
        userName = getString(1),
        trophySync = getLong(2),
        accountId = if (isNull(3)) null else getLong(3),
        loginId = getString(4),
        onlineId = getString(5),
        avatar = getString(6),
        npenv = getString(7),
        onlineUser = getLong(8),
        targetOwner = getLong(9),
        targetUserId = getLong(10),
        uuid = getString(11),
        savedataAutoUpload = getLong(12),
        savedataAutoSync = getLong(13),
    )

    private fun SqlRow.toSavedataRow() = SavedataRow(
        userId = getLong(0),
        titleId = getString(1) ?: "",
        pathToTitleId = getString(2) ?: "",
        size = getLong(3),
        buSize = getLong(4),
        formatType = getLong(5),
        uploadSetting = getLong(6),
        alreadyExists = getLong(7),
        lastModifiedTime = getLong(8),
    )
}

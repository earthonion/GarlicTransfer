package com.garlictransfer.core.metadata

import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.util.toHex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.security.MessageDigest

internal fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

private val testJson = Json { prettyPrint = true }

internal fun prettyPrint(element: JsonElement): String = testJson.encodeToString(JsonElement.serializer(), element)

internal fun itemJson(item: PayloadFile): JsonObject = JsonObject(
    linkedMapOf(
        "path" to JsonPrimitive(item.path),
        "file" to JsonPrimitive(item.file),
        "size" to JsonPrimitive(item.size),
        "sha256" to JsonPrimitive(item.sha256),
        "header" to JsonPrimitive(item.header),
    )
)

internal fun payloadItem(entryId: Long, path: String, name: String, size: Long, sha256: String = "stale"): PayloadFile =
    PayloadFile(path, name, size, sha256, Gfp5.build(entryId, size, path).toHex())

/** Writes payloads plus the dual-shape root and per-entry manifests, mirroring poc test fixtures. */
internal fun saveCase(
    root: File,
    userId: String,
    entryId: Long,
    titleId: String,
    payloads: List<Pair<String, ByteArray>>,
    rootManifest: Boolean = true,
): File {
    val assets = File(root, "assets")
    val entryDir = File(assets, entryId.toString())
    entryDir.mkdirs()
    val items = payloads.map { (name, data) ->
        File(entryDir, name).writeBytes(data)
        payloadItem(entryId, "/user/home/$userId/savedata_prospero/$titleId/$name", name, data.size.toLong())
    }
    val manifest = EntryManifest(entryId, items.toMutableList(), Gfp5.finalHeader(entryId).toHex())
    File(entryDir, "manifest.json").writeText(manifest.toJson() + "\n")
    if (rootManifest) File(assets, "manifest.json").writeText(manifest.toJson() + "\n")
    return assets
}

/** A copy of the bundled template db with its user rebound to [userId], like the poc tests do. */
internal fun sourceDb(root: File, userId: String): File {
    val source = File(root, "source.db")
    MetadataTemplates.singleSaveDb(root).copyTo(source, overwrite = true)
    withDb(source) { db ->
        db.update("UPDATE user_info_tbl SET user_id = ?", userId.toLong(16))
    }
    return source
}

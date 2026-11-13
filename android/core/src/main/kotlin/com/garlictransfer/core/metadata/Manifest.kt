package com.garlictransfer.core.metadata

import com.garlictransfer.core.DtException
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.IOException

/** One payload file tracked by a manifest. [size]/[sha256]/[header] are refreshed from disk by validation. */
data class PayloadFile(
    val path: String,
    val file: String,
    var size: Long,
    var sha256: String,
    var header: String,
)

/** Per-entry manifest: files plus the terminal GFP5 header (hex). */
data class EntryManifest(
    val entryId: Long,
    val files: MutableList<PayloadFile>,
    var finalHeader: String,
)

@OptIn(ExperimentalSerializationApi::class)
internal val ManifestJson: Json = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

internal fun JsonElement.toJsonText(): String = ManifestJson.encodeToString(JsonElement.serializer(), this)

internal fun PayloadFile.toJsonObject(): JsonObject = JsonObject(
    linkedMapOf(
        "path" to JsonPrimitive(path),
        "file" to JsonPrimitive(file),
        "size" to JsonPrimitive(size),
        "sha256" to JsonPrimitive(sha256),
        "header" to JsonPrimitive(header),
    )
)

internal fun EntryManifest.toEntryJsonObject(): JsonObject = JsonObject(
    linkedMapOf(
        "files" to JsonArray(files.map { it.toJsonObject() }),
        "final_header" to JsonPrimitive(finalHeader),
    )
)

fun EntryManifest.toJson(): String = JsonObject(
    linkedMapOf(
        "entry_id" to JsonPrimitive(entryId),
        "files" to JsonArray(files.map { it.toJsonObject() }),
        entryId.toString() to toEntryJsonObject(),
    )
).toJsonText()

fun parseEntryManifest(entryId: Long, json: String): EntryManifest {
    val root = parseJsonObject(json)
    val entryObject = root[entryId.toString()] as? JsonObject
    val filesElement = entryObject?.get("files") ?: root["files"]
    val filesArray = filesElement as? JsonArray
    if (filesArray.isNullOrEmpty()) throw DtException("save manifest for entry $entryId contains no files")
    val finalHeader = ((entryObject?.get("final_header") ?: root["final_header"]) as? JsonPrimitive)?.contentOrNull
    if (finalHeader.isNullOrEmpty()) {
        throw DtException("entry $entryId lacks a GFP5 final header; redownload it with this version")
    }
    val files = filesArray.map { element ->
        val item = element as? JsonObject ?: throw DtException("entry $entryId has an invalid save filename")
        PayloadFile(
            path = (item["path"] as? JsonPrimitive)?.contentOrNull
                ?: throw DtException("save file in entry $entryId lacks its console path"),
            file = (item["file"] as? JsonPrimitive)?.contentOrNull
                ?: throw DtException("entry $entryId has an invalid save filename"),
            size = (item["size"] as? JsonPrimitive)?.longOrNull ?: 0,
            sha256 = (item["sha256"] as? JsonPrimitive)?.contentOrNull ?: "",
            header = (item["header"] as? JsonPrimitive)?.contentOrNull ?: "",
        )
    }.toMutableList()
    return EntryManifest(entryId, files, finalHeader)
}

internal fun parseJsonObject(text: String): JsonObject {
    val element = try {
        Json.parseToJsonElement(text)
    } catch (e: SerializationException) {
        throw DtException("save manifest is not valid JSON: ${e.message}", e)
    }
    return element as? JsonObject ?: throw DtException("save manifest is not a JSON object")
}

internal fun parseJsonObjectFile(file: File): JsonObject = try {
    parseJsonObject(file.readText())
} catch (e: IOException) {
    throw DtException("save manifest $file cannot be read: ${e.message}", e)
}

/** Extracts the bundled single-save template db into [destDir] and returns the file. */
object MetadataTemplates {
    fun singleSaveDb(destDir: File): File {
        val resource = javaClass.getResourceAsStream("/templates/single-save.db")
            ?: throw DtException("the bundled single-save.db template is missing")
        destDir.mkdirs()
        val target = File(destDir, "single-save-template.db")
        resource.use { input -> target.outputStream().use { output -> input.copyTo(output) } }
        return target
    }
}

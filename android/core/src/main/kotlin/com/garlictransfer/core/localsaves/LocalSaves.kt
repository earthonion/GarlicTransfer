package com.garlictransfer.core.localsaves

import com.garlictransfer.core.DtException
import com.garlictransfer.core.metadata.EntryManifest
import com.garlictransfer.core.metadata.Metadata
import com.garlictransfer.core.metadata.parseJsonObjectFile
import com.garlictransfer.core.metadata.toEntryJsonObject
import com.garlictransfer.core.metadata.toJsonObject
import com.garlictransfer.core.metadata.toJsonText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

data class LocalFile(
    val file: String,
    val path: String,
    val size: Long,
    val sha256: String,
)

data class LocalEntry(
    val id: Long,
    val title: String,
    val owner: String,
    val files: List<LocalFile>,
)

/** Local save library; port of poc/dt_local_saves.py. Revalidating loads refresh size/hash/header from disk. */
object LocalSaves {

    fun inventory(assets: File): List<LocalEntry> {
        val entryIds = sortedSetOf<Long>()
        val rootManifest = File(assets, "manifest.json")
        if (rootManifest.isFile) {
            for (key in parseJsonObjectFile(rootManifest).keys) {
                if (key.isNotEmpty() && key.all(Char::isDigit)) entryIds.add(key.toLong())
            }
        }
        if (assets.isDirectory) {
            assets.listFiles()?.forEach { child ->
                if (child.isDirectory && child.name.isNotEmpty() && child.name.all(Char::isDigit)
                    && File(child, "manifest.json").isFile
                ) {
                    entryIds.add(child.name.toLong())
                }
            }
        }
        if (entryIds.isEmpty()) throw DtException("no downloaded saves were found under $assets")
        return entryIds.map { id ->
            val (actualId, entry) = Metadata.loadManifest(assets, id)
            publicEntry(actualId, entry)
        }
    }

    fun export(assets: File, entryId: Long, filename: String, destinationDir: File): File {
        val (_, _, sourceFile) = selectedFile(assets, entryId, filename)
        if (!destinationDir.isDirectory) throw DtException("select an existing export directory")
        val target = File(destinationDir, sourceFile.name)
        if (sourceFile.canonicalFile == target.canonicalFile) {
            throw DtException("the export destination is the same as the source file")
        }
        sourceFile.copyTo(target, overwrite = true)
        return target
    }

    /** Copies [source] over the tracked file atomically, then regenerates size/SHA-256/header and both manifests. */
    fun import(assets: File, entryId: Long, filename: String, source: File): LocalEntry {
        val (actualId, _, target) = selectedFile(assets, entryId, filename)
        if (!source.isFile || source.length() <= 0) throw DtException("the import image is missing or empty")
        if (source.canonicalFile == target.canonicalFile) {
            throw DtException("the import source and destination are the same file")
        }
        val temporary = File(target.parentFile, target.name + ".import.tmp")
        source.copyTo(temporary, overwrite = true)
        try {
            RandomAccessFile(temporary, "rw").use { it.fd.sync() }
            moveAtomic(temporary, target)
            val (refreshedId, refreshed) = Metadata.loadManifest(assets, actualId)
            replaceManifest(assets, refreshedId, refreshed)
            return publicEntry(refreshedId, refreshed)
        } finally {
            temporary.delete()
        }
    }

    private fun selectedFile(assets: File, entryId: Long, filename: String): Triple<Long, EntryManifest, File> {
        val (actualId, entry) = Metadata.loadManifest(assets, entryId)
        if (entry.files.none { it.file == filename }) {
            throw DtException("save file $filename is not present in entry $entryId")
        }
        val path = listOf(File(assets, "$entryId/$filename"), File(assets, filename)).firstOrNull { it.isFile }
            ?: throw DtException("save file for entry $entryId is missing: $filename")
        return Triple(actualId, entry, path)
    }

    private fun publicEntry(entryId: Long, entry: EntryManifest): LocalEntry {
        val files = entry.files.map { LocalFile(file = it.file, path = it.path, size = it.size, sha256 = it.sha256) }
        val owner = files.firstOrNull()?.path?.trim('/')?.split('/')?.getOrNull(2) ?: ""
        return LocalEntry(id = entryId, title = Metadata.inferTitleId(files.map { it.path }), owner = owner, files = files)
    }

    private fun replaceManifest(assets: File, entryId: Long, entry: EntryManifest) {
        val rootPath = File(assets, "manifest.json")
        if (rootPath.isFile) {
            val document = LinkedHashMap(parseJsonObjectFile(rootPath))
            document[entryId.toString()] = entry.toEntryJsonObject()
            writeJsonAtomic(rootPath, JsonObject(document))
        }
        val entryPath = File(assets, "$entryId/manifest.json")
        val document = if (entryPath.isFile) LinkedHashMap(parseJsonObjectFile(entryPath)) else LinkedHashMap()
        document["entry_id"] = JsonPrimitive(entryId)
        document["files"] = JsonArray(entry.files.map { it.toJsonObject() })
        document[entryId.toString()] = entry.toEntryJsonObject()
        writeJsonAtomic(entryPath, JsonObject(document))
    }

    private fun writeJsonAtomic(path: File, document: JsonObject) {
        val temporary = File(path.parentFile, path.name + ".import.tmp")
        temporary.writeText(document.toJsonText() + "\n")
        moveAtomic(temporary, path)
    }

    private fun moveAtomic(source: File, target: File) {
        try {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

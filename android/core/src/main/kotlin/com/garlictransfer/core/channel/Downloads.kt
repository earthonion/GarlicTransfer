package com.garlictransfer.core.channel

import com.garlictransfer.core.DtException
import com.garlictransfer.core.gfp5.GFP5_HEADER_SIZE
import com.garlictransfer.core.gfp5.GFP5_MAGIC
import com.garlictransfer.core.gfp5.Gfp5
import com.garlictransfer.core.util.leBuffer
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.toHex
import com.garlictransfer.core.util.u64ToLe
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

object Downloads {
    private const val CMD_PREPARE = 0xA0
    private const val CMD_TRANSFER = 0xB2
    private const val RESULT_BUSY = 0x23L
    private const val BUSY_POLL_MS = 250L

    internal var prepareDeadlineMs: Long = 120_000L

    @OptIn(ExperimentalSerializationApi::class)
    private val manifestJson = Json { prettyPrint = true; prettyPrintIndent = "  " }

    /**
     * 0xA0 prepare (busy = 0x23 polled every 250 ms, absolute deadline 120 s), then 0xB2 type 1;
     * writes the metadata bytes verbatim to `<outputDir>/metadata.db` and returns it.
     */
    fun downloadMetadata(channel: DtChannel, outputDir: File, onStatus: ((String) -> Unit)? = null): File {
        onStatus?.invoke("Asking the console to gather save metadata")
        val prepareSub = channel.request(CMD_PREPARE, u64ToLe(11))
        val deadline = System.currentTimeMillis() + prepareDeadlineMs
        while (true) {
            val result = channel.response(CMD_PREPARE, prepareSub).result
            if (result == 0L) break
            if (result != RESULT_BUSY) throw DtException("A0 failed: result 0x${result.toString(16)}")
            if (System.currentTimeMillis() >= deadline) throw DtException("A0 did not complete")
            Thread.sleep(BUSY_POLL_MS)
        }

        onStatus?.invoke("Downloading metadata.db")
        val metadataSub = channel.request(CMD_TRANSFER, leBuffer(8).putInt(1).putInt(1).array())
        val metadata = channel.response(CMD_TRANSFER, metadataSub)
        if (metadata.result != 0L) {
            throw DtException("metadata request failed: 0x${metadata.result.toString(16)}")
        }
        outputDir.mkdirs()
        val target = File(outputDir, "metadata.db")
        target.writeBytes(metadata.body)
        onStatus?.invoke("Saved metadata.db (${metadata.body.size} bytes)")
        return target
    }

    /**
     * 0xB2 type 2 for [entryId]; receives the GFP5 record stream into `<outputDir>/<entryId>/`,
     * writes files as `<name>.part` then renames, and finally writes the entry manifest.json
     * (see poc/dt_download.py for the exact JSON shape). Returns the manifest file.
     */
    fun downloadEntry(channel: DtChannel, entryId: Long, outputDir: File, packageOnly: Boolean = false): File {
        val sub = channel.request(CMD_TRANSFER, leBuffer(8).putInt(2).putInt(entryId.toInt()).array())
        val response = channel.response(CMD_TRANSFER, sub)
        if (response.result != 0L) {
            throw DtException("entry $entryId request failed: 0x${response.result.toString(16)}")
        }

        val entryDir = File(outputDir, entryId.toString())
        entryDir.mkdirs()
        val files = mutableListOf<JsonObject>()
        var finalHeader: String? = null
        while (true) {
            val raw = channel.recvRecord()
            if (raw.size != GFP5_HEADER_SIZE || leReader(raw).int.toLong() and 0xFFFFFFFFL != GFP5_MAGIC) {
                throw DtException("invalid GFP5 header: ${raw.size} bytes")
            }
            val header = Gfp5.parse(raw)
            if (header.fileId != entryId) {
                throw DtException("file ID mismatch: ${header.fileId} != $entryId")
            }
            if (header.isFinal) {
                finalHeader = raw.toHex()
                break
            }

            val name = header.path.substringAfterLast('/')
            if (name.isEmpty()) throw DtException("invalid source path: ${header.path}")
            val keep = !packageOnly || header.path.endsWith(".pkg", ignoreCase = true)
            val destination = File(entryDir, name)
            val partial = File(entryDir, "$name.part")
            val digest = MessageDigest.getInstance("SHA-256")
            var remaining = header.size
            val stream = if (keep) BufferedOutputStream(FileOutputStream(partial)) else null
            try {
                while (remaining > 0) {
                    var chunk = channel.recvRecord()
                    if (chunk.size.toLong() > remaining) chunk = chunk.copyOf(remaining.toInt())
                    stream?.write(chunk)
                    if (keep) digest.update(chunk)
                    remaining -= chunk.size
                }
            } finally {
                stream?.close()
            }
            if (!keep) continue
            Files.move(partial.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
            files.add(
                buildJsonObject {
                    put("path", header.path)
                    put("file", name)
                    put("size", header.size)
                    put("sha256", digest.digest().toHex())
                    put("header", raw.toHex())
                },
            )
        }

        val filesArray = buildJsonArray { files.forEach { add(it) } }
        val manifest = buildJsonObject {
            put("entry_id", entryId)
            put("files", filesArray)
            put(
                entryId.toString(),
                buildJsonObject {
                    put("files", filesArray)
                    put("final_header", finalHeader)
                },
            )
        }
        val manifestFile = File(entryDir, "manifest.json")
        manifestFile.writeText(manifestJson.encodeToString(JsonObject.serializer(), manifest) + "\n")
        return manifestFile
    }

    /** Rebuilds the root manifest from per-entry manifests; returns the set of downloaded entry ids. */
    fun indexDownloadedManifests(outputDir: File): Set<Long> {
        val combined = LinkedHashMap<String, JsonObject>()
        val downloaded = LinkedHashSet<Long>()
        val children = outputDir.listFiles()
            ?.filter { it.isDirectory && it.name.isNotEmpty() && it.name.all(Char::isDigit) }
            ?.sortedBy { it.name }
            ?: emptyList()
        for (dir in children) {
            val manifestFile = File(dir, "manifest.json")
            if (!manifestFile.isFile) continue
            try {
                val entryId = dir.name.toLong()
                val manifest = Json.parseToJsonElement(manifestFile.readText()) as? JsonObject ?: continue
                val entry = manifest[dir.name] as? JsonObject
                val files = (entry?.get("files") ?: manifest["files"]) as? JsonArray ?: continue
                val finalHeader = entry?.get("final_header")?.jsonPrimitive?.contentOrNull
                if (files.isEmpty() || finalHeader.isNullOrEmpty()) continue
                val complete = files.all { item ->
                    val file = item as? JsonObject ?: return@all false
                    val headerHex = file["header"]?.jsonPrimitive?.contentOrNull
                    val fileName = file["file"]?.jsonPrimitive?.contentOrNull
                    !headerHex.isNullOrEmpty() && fileName != null && File(dir, fileName).isFile
                }
                if (!complete) continue
                combined[dir.name] = buildJsonObject {
                    put("files", files)
                    put("final_header", finalHeader)
                }
                downloaded.add(entryId)
            } catch (failure: Exception) {
                continue
            }
        }
        File(outputDir, "manifest.json").writeText(
            manifestJson.encodeToString(JsonObject.serializer(), JsonObject(combined)) + "\n",
        )
        return downloaded
    }
}

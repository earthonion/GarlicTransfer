package com.garlictransfer.core.gfp5

import com.garlictransfer.core.util.leBuffer
import com.garlictransfer.core.util.leReader

const val GFP5_MAGIC: Long = 0x35504647
const val GFP5_HEADER_SIZE: Int = 1304
const val GFP5_MODE_REGULAR: Int = 0x8180

/** Fixed-layout 1304-byte GFP5 file record header. */
data class Gfp5Header(
    val fileId: Long,
    val size: Long,
    val isFinal: Boolean,
    val path: String,
    val raw: ByteArray,
) {
    override fun equals(other: Any?): Boolean = other is Gfp5Header && raw.contentEquals(other.raw)
    override fun hashCode(): Int = raw.contentHashCode()
}

object Gfp5 {
    fun parse(raw: ByteArray): Gfp5Header {
        require(raw.size == GFP5_HEADER_SIZE) { "GFP5 header is $GFP5_HEADER_SIZE bytes" }
        val reader = leReader(raw)
        require(reader.int.toLong() and 0xFFFFFFFFL == GFP5_MAGIC) { "bad GFP5 magic" }
        val fileId = reader.int.toLong() and 0xFFFFFFFFL
        val size = leReader(raw).apply { position(0xF0) }.long
        val isFinal = raw[274].toInt() != 0
        val pathBytes = raw.copyOfRange(276, 1300)
        val end = pathBytes.indexOf(0.toByte()).let { if (it < 0) pathBytes.size else it }
        val path = String(pathBytes, 0, end, Charsets.UTF_8)
        return Gfp5Header(fileId, size, isFinal, path, raw)
    }

    fun build(fileId: Long, size: Long, path: String, isFinal: Boolean = false, mode: Int = GFP5_MODE_REGULAR): ByteArray {
        val out = ByteArray(GFP5_HEADER_SIZE)
        val writer = leBuffer(GFP5_HEADER_SIZE)
        writer.putInt(GFP5_MAGIC.toInt())
        writer.putInt(fileId.toInt())
        System.arraycopy(writer.array(), 0, out, 0, 8)
        leBuffer(8).putLong(size).array().also {
            System.arraycopy(it, 0, out, 0x20, 8)
            System.arraycopy(it, 0, out, 0xF0, 8)
        }
        leBuffer(2).putShort(mode.toShort()).array().also { System.arraycopy(it, 0, out, 0x110, 2) }
        if (isFinal) out[274] = 1
        val pathBytes = path.toByteArray(Charsets.UTF_8)
        require(pathBytes.size <= 1024) { "GFP5 path too long" }
        System.arraycopy(pathBytes, 0, out, 276, pathBytes.size)
        return out
    }

    fun finalHeader(fileId: Long): ByteArray {
        val out = ByteArray(GFP5_HEADER_SIZE)
        System.arraycopy(leBuffer(8).putInt(GFP5_MAGIC.toInt()).putInt(fileId.toInt()).array(), 0, out, 0, 8)
        out[274] = 1
        return out
    }

    /** Returns a copy of [raw] with the size fields at 0x20 and 0xF0 set to [newSize]. */
    fun patchSize(raw: ByteArray, newSize: Long): ByteArray {
        require(raw.size == GFP5_HEADER_SIZE)
        val out = raw.copyOf()
        val sizeBytes = leBuffer(8).putLong(newSize).array()
        System.arraycopy(sizeBytes, 0, out, 0x20, 8)
        System.arraycopy(sizeBytes, 0, out, 0xF0, 8)
        return out
    }
}

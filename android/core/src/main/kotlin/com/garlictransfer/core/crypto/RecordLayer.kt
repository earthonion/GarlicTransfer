package com.garlictransfer.core.crypto

import com.garlictransfer.core.util.leBuffer
import com.garlictransfer.core.util.leReader
import com.garlictransfer.core.util.recvExact
import java.io.InputStream
import java.io.OutputStream
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

const val RECORD_VERSION: Long = 8
const val RECORD_MAX_SIZE: Int = 0x400000
const val BODY_CHUNK_SIZE: Int = 0x200000
const val RECORD_HEADER_SIZE: Int = 24
const val GCM_TAG_SIZE: Int = 16

fun pad(plaintext: ByteArray): ByteArray {
    val count = 16 - plaintext.size % 16
    return plaintext + ByteArray(count - 1) + count.toByte()
}

fun unpad(padded: ByteArray): ByteArray {
    require(padded.isNotEmpty()) { "empty plaintext" }
    val count = padded.last().toInt() and 0xFF
    require(count in 1..16 && padded.size >= count) { "invalid record padding" }
    return padded.copyOf(padded.size - count)
}

private fun nonce(noncePrefix: ByteArray, sequence: Long): ByteArray =
    noncePrefix + leBuffer(8).putLong(sequence).array()

/** AES-128-GCM record framing used by both Data Transfer channels. */
class RecordLayer(private val input: InputStream, private val output: OutputStream) {

    @Synchronized
    fun send(key: ByteArray, noncePrefix: ByteArray, sequence: Long, plaintext: ByteArray) {
        val padded = pad(plaintext)
        val header = leBuffer(RECORD_HEADER_SIZE)
            .putLong(RECORD_VERSION)
            .putLong(sequence)
            .putLong(padded.size.toLong())
            .array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(noncePrefix, sequence)))
        cipher.updateAAD(header)
        output.write(header)
        output.write(cipher.doFinal(padded))
        output.flush()
    }

    fun recv(key: ByteArray, noncePrefix: ByteArray, sequence: Long): ByteArray {
        val header = recvExact(input, RECORD_HEADER_SIZE)
        val reader = leReader(header)
        val version = reader.long
        val wireSequence = reader.long
        val size = reader.long
        require(version == RECORD_VERSION && wireSequence == sequence && size <= RECORD_MAX_SIZE) {
            "unexpected record header: ${header.toHex()}"
        }
        val encrypted = recvExact(input, size.toInt() + GCM_TAG_SIZE)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce(noncePrefix, sequence)))
        cipher.updateAAD(header)
        return unpad(cipher.doFinal(encrypted))
    }
}

private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }

/** 16-byte command header: cmd u8, sub u8, version u16, result u32, body size u64. */
data class CommandHeader(
    val cmd: Int,
    val sub: Int,
    val version: Int,
    val result: Long,
    val bodySize: Long,
) {
    fun pack(): ByteArray = leBuffer(SIZE)
        .put(cmd.toByte())
        .put(sub.toByte())
        .putShort(version.toShort())
        .putInt(result.toInt())
        .putLong(bodySize)
        .array()

    companion object {
        const val SIZE = 16

        fun parse(bytes: ByteArray): CommandHeader {
            require(bytes.size == SIZE) { "command header is $SIZE bytes" }
            val reader = leReader(bytes)
            return CommandHeader(
                cmd = reader.get().toInt() and 0xFF,
                sub = reader.get().toInt() and 0xFF,
                version = reader.short.toInt() and 0xFFFF,
                result = reader.int.toLong() and 0xFFFFFFFFL,
                bodySize = reader.long,
            )
        }
    }
}

fun commandHeader(cmd: Int, bodySize: Long, sub: Int = 2, version: Int = 0x130): ByteArray =
    CommandHeader(cmd, sub, version, 0, bodySize).pack()

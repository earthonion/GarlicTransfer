package com.garlictransfer.core.util

import java.io.EOFException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0) { "odd hex length" }
    return ByteArray(length / 2) { i -> ((this[2 * i].digitToInt(16) shl 4) or this[2 * i + 1].digitToInt(16)).toByte() }
}

fun leBuffer(capacity: Int): ByteBuffer = ByteBuffer.allocate(capacity).order(ByteOrder.LITTLE_ENDIAN)

fun leReader(bytes: ByteArray): ByteBuffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

fun recvExact(input: InputStream, size: Int): ByteArray {
    val out = ByteArray(size)
    var off = 0
    while (off < size) {
        val n = input.read(out, off, size - off)
        if (n < 0) throw EOFException("connection closed after $off/$size bytes")
        off += n
    }
    return out
}

fun u64ToLe(value: Long): ByteArray = leBuffer(8).putLong(value).array()

fun be64(value: Long): ByteArray = ByteBuffer.allocate(8).putLong(value).array()

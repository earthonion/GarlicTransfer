package com.garlictransfer.core.crypto

import com.garlictransfer.core.util.hexToBytes
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

val PSK: ByteArray = "59e63288b04e7f68f8b8db83861e0750".hexToBytes()

/** Session keys for one encrypted channel, from the initiator's perspective. */
data class SessionKeys(
    val sendKey: ByteArray,
    val recvKey: ByteArray,
    val sendNoncePrefix: ByteArray,
    val recvNoncePrefix: ByteArray,
) {
    init {
        require(sendKey.size == 16 && recvKey.size == 16)
        require(sendNoncePrefix.size == 4 && recvNoncePrefix.size == 4)
    }

    /** The same channel seen from the other endpoint. */
    fun swapped(): SessionKeys = SessionKeys(recvKey, sendKey, recvNoncePrefix, sendNoncePrefix)

    override fun equals(other: Any?): Boolean =
        other is SessionKeys &&
            sendKey.contentEquals(other.sendKey) && recvKey.contentEquals(other.recvKey) &&
            sendNoncePrefix.contentEquals(other.sendNoncePrefix) && recvNoncePrefix.contentEquals(other.recvNoncePrefix)

    override fun hashCode(): Int = sendKey.contentHashCode()
}

private fun aesEcb(key: ByteArray): Cipher =
    Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")) }

fun aesEcbDecryptBlock(key: ByteArray, block: ByteArray): ByteArray {
    require(block.size == 16) { "AES input must be one block" }
    val cipher = Cipher.getInstance("AES/ECB/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"))
    return cipher.doFinal(block)
}

private fun dbl(block: ByteArray): ByteArray {
    val out = ByteArray(16)
    var carry = 0
    for (i in 15 downTo 0) {
        val v = block[i].toInt() and 0xFF
        out[i] = ((v shl 1) or carry).toByte()
        carry = v ushr 7
    }
    if (carry != 0) out[15] = (out[15].toInt() xor 0x87).toByte()
    return out
}

private fun xorInto(target: ByteArray, other: ByteArray) {
    for (i in target.indices) target[i] = (target[i].toInt() xor other[i].toInt()).toByte()
}

/** AES-128 CMAC (RFC 4493). */
fun cmacAes(key: ByteArray, message: ByteArray): ByteArray {
    val cipher = aesEcb(key)
    val l = cipher.doFinal(ByteArray(16))
    val k1 = dbl(l)
    val k2 = dbl(k1)
    val blockCount = if (message.isEmpty()) 1 else (message.size + 15) / 16
    val last = ByteArray(16)
    if (message.isNotEmpty() && message.size % 16 == 0) {
        System.arraycopy(message, (blockCount - 1) * 16, last, 0, 16)
        xorInto(last, k1)
    } else {
        val rem = message.size - (blockCount - 1) * 16
        System.arraycopy(message, (blockCount - 1) * 16, last, 0, rem)
        last[rem] = 0x80.toByte()
        xorInto(last, k2)
    }
    var state = ByteArray(16)
    for (i in 0 until blockCount - 1) {
        val block = message.copyOfRange(i * 16, i * 16 + 16)
        xorInto(block, state)
        state = cipher.doFinal(block)
    }
    xorInto(last, state)
    return cipher.doFinal(last)
}

/** Local "SblNcdtPsk" KDF used on IPv6 channels and by the emulated source. */
fun deriveKeys(clientValue: ByteArray, serverValue: ByteArray): SessionKeys {
    require(clientValue.size == 16 && serverValue.size == 16) { "client/server values are 16 bytes" }
    val source = byteArrayOf(0x00, 0x10) + PSK + aesEcbDecryptBlock(PSK, clientValue) + aesEcbDecryptBlock(PSK, serverValue)
    val k1 = cmacAes(PSK, byteArrayOf(0, 1) + source)
    val k2 = cmacAes(PSK, byteArrayOf(0, 2) + source)
    val k3 = cmacAes(PSK, byteArrayOf(0, 3) + source)
    return SessionKeys(k1, k2, k3.copyOfRange(0, 4), k3.copyOfRange(4, 8))
}

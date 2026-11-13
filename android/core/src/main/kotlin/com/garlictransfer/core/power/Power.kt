package com.garlictransfer.core.power

import com.garlictransfer.core.DtException
import com.garlictransfer.core.metadata.SqlDb
import com.garlictransfer.core.util.be64
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.leBuffer
import com.garlictransfer.core.util.toHex
import java.io.File
import java.security.MessageDigest

const val FIRMWARE_14_22: Int = 0x14220000
const val PRODUCT_CODE_14_22: Int = 0x284

object Power {
    val CAPTURED_BODY: ByteArray = (
        "c6e469cc8242a4e1c3dbdaf6e206d6c6" +
            "7bab7d471e62dc60cae6b9596a783b7e" +
            "5c843cc6d72700002c01000002000000" +
            "82020000010000006e70000000000000" +
            "00000000000000000000000007006013" +
            "0100000007006013"
        ).hexToBytes()

    const val LEGACY_BODY_HOST_ID = "5C843CC6D727"

    private val ACCOUNT_ID_REGEX = Regex("[0-9]+")
    private val KNOWN_HARDWARE = mapOf(LEGACY_BODY_HOST_ID to 2, "5C96661F7C1A" to 3)

    init {
        require(CAPTURED_BODY.size == 88)
    }

    fun accountHashPrefix(accountId: String): ByteArray {
        val trimmed = accountId.trim()
        require(trimmed.matches(ACCOUNT_ID_REGEX)) { "account ID must be a decimal string" }
        val value = trimmed.toBigInteger()
        require(value < java.math.BigInteger.ONE.shiftLeft(64)) { "account ID out of range" }
        return MessageDigest.getInstance("SHA-256").digest(be64(value.toLong()))
    }

    fun loadPrefixFile(file: File): ByteArray {
        val bytes = file.inputStream().use { it.readNBytes(33) }
        require(bytes.size == 32) { "pairing prefix must be exactly 32 bytes" }
        return bytes
    }

    /** Hash of the single online owner's uuid, or null when the metadata has none/several. */
    fun prefixFromMetadata(db: SqlDb): ByteArray? {
        val uuids = db.query(
            "SELECT DISTINCT uuid FROM user_info_tbl WHERE target_owner = 1 AND online_user = 1",
        ) { it.getString(0) }.filterNotNull()
        if (uuids.size != 1) return null
        val uuid = uuids[0]
        if (!Regex("[0-9a-fA-F]{16}").matches(uuid)) return null
        return MessageDigest.getInstance("SHA-256").digest(uuid.hexToBytes())
    }

    fun hardwareId(hostId: String?, explicit: Int = 0): Int =
        if (explicit != 0) explicit else KNOWN_HARDWARE[hostId?.uppercase()] ?: 3

    fun buildPowerRequestBody(firmware: Int, hardware: Int, hostIdHex: String? = null, prefix: ByteArray? = null): ByteArray {
        val body = CAPTURED_BODY.copyOf()
        if (prefix != null) {
            require(prefix.size == 32) { "approval prefix is 32 bytes" }
            System.arraycopy(prefix, 0, body, 0, 32)
        }
        if (hostIdHex != null && Regex("[0-9a-fA-F]{12}").matches(hostIdHex)) {
            System.arraycopy(hostIdHex.hexToBytes(), 0, body, 32, 6)
        }
        leBuffer(4).putInt(hardware).array().also { System.arraycopy(it, 0, body, 44, 4) }
        if (firmware == FIRMWARE_14_22) {
            leBuffer(4).putInt(PRODUCT_CODE_14_22).array().also { System.arraycopy(it, 0, body, 48, 4) }
        }
        leBuffer(4).putInt(firmware).array().also {
            System.arraycopy(it, 0, body, 76, 4)
            System.arraycopy(it, 0, body, 84, 4)
        }
        return body
    }
}

fun powerResultHint(result: Long, hostId: String?): String = when (result) {
    0x11L -> "Request User is not exist on the console; the account ID or pairing prefix belongs to a different PSN user."
    0x17L -> "Hardware mismatch for host ${hostId ?: "unknown"}; set the correct hardware ID in settings."
    else -> "power request failed with result 0x${result.toString(16)}"
}

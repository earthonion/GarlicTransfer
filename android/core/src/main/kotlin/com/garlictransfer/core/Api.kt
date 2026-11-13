package com.garlictransfer.core

class DtException(message: String, cause: Throwable? = null) : Exception(message, cause)

data class DiscoveredConsole(
    val host: String,
    val name: String,
    val type: String,
    val hostId: String,
    val firmware: String,
    val requestPort: String,
    val network: String,
    val address: String,
)

data class ConsoleUser(val id: String, val name: String)

enum class EntryKind(val wire: String) {
    SAVE("save"), APP("app"), PROFILE("profile"), MEDIA("media"), OTHER("other");

    companion object {
        fun of(path: String, targetType: Int): EntryKind = when {
            targetType == 3 -> SAVE
            targetType == 1 && path.startsWith("/user/app/") -> APP
            targetType == 0 -> PROFILE
            targetType == 2 -> MEDIA
            else -> OTHER
        }
    }
}

data class SaveEntry(
    val id: Long,
    val title: String,
    val kind: EntryKind,
    val owner: String,
    val size: Long,
    val downloaded: Boolean,
)

sealed interface TransferEvent {
    data class Status(val step: String, val message: String) : TransferEvent
    data class Log(val message: String) : TransferEvent
    data class PowerRequired(val message: String) : TransferEvent
    data class Entries(val entries: List<SaveEntry>, val users: List<ConsoleUser>) : TransferEvent
    data class Ready(val message: String) : TransferEvent
    data class Downloaded(val entryIds: List<Long>) : TransferEvent
    data class Done(val message: String) : TransferEvent
    data class Error(val message: String) : TransferEvent
}

fun interface TransferListener {
    fun onEvent(event: TransferEvent)
}

/** Configuration for the upload path: this device pretends to be the source console. */
data class UploadConfig(
    val metadataPath: String,
    val assetsPath: String,
    val manifestPath: String = "$assetsPath/manifest.json",
    val commandPort: Int = 1004,
    val dataPort: Int = 1005,
    val discoveryPort: Int = 1006,
    val oracleHost: String = "192.168.0.125",
    val oraclePort: Int = 9022,
    val systemVersion: String = "14200007",
    val hostId: String = "020000000001",
    val hostName: String = "GarlicTransfer",
    val bindAddress: String? = null,
    val advertiseAddress: String? = null,
    val useLocalPsk: Boolean = false,
    val uploadKind: String = "save",
    val autoPowerDelayMs: Long? = null,
    val pairingPrefixPath: String? = null,
    val expectedHostId: String? = null,
)

data class PairingOptions(
    val ps5Ip: String,
    val hostId: String,
    val systemVersion: String,
    val oracleHost: String,
    val oraclePort: Int = 9022,
    val prefixPath: String,
    val durationSec: Int = 180,
    val bindIp: String? = null,
    val discoveryPort: Int = 1006,
    val commandPort: Int = 1004,
)

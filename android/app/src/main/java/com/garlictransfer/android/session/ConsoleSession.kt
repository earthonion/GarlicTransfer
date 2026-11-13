package com.garlictransfer.android.session

import com.garlictransfer.android.settings.AppSettings
import com.garlictransfer.core.ConsoleUser
import com.garlictransfer.core.DiscoveredConsole
import com.garlictransfer.core.DtException
import com.garlictransfer.core.EntryKind
import com.garlictransfer.core.SaveEntry
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.channel.Downloads
import com.garlictransfer.core.channel.DtChannel
import com.garlictransfer.core.ddp.Ddp
import com.garlictransfer.core.metadata.Metadata
import com.garlictransfer.core.metadata.SqlDbFactory
import com.garlictransfer.core.oracle.HtosDeriver
import com.garlictransfer.core.oracle.KeyDeriver
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.oracle.OracleDeriver
import com.garlictransfer.core.power.Power
import com.garlictransfer.core.power.powerResultHint
import com.garlictransfer.core.util.hexToBytes
import java.io.EOFException
import java.io.File
import java.net.Inet6Address
import java.net.InetAddress
import java.net.SocketException

enum class IdentityChoice { AccountId, PairingPrefix, MetadataOwner }

/**
 * Port of poc/dt_backend.py's download flow: launch + 0x91 approval on the command
 * channel, metadata + entry downloads on the data channel, 0x94 to finish. All methods
 * block; call them from Dispatchers.IO. Events stream to [listener].
 */
class ConsoleSession(
    private val console: DiscoveredConsole,
    private val settings: AppSettings,
    private val profileDir: File,
    private val dbFactory: SqlDbFactory,
    private val listener: TransferListener,
) {
    var firmwareVersion: Int = 0
        private set
    var hostId: String = console.hostId
        private set

    private var command: DtChannel? = null
    private var data: DtChannel? = null
    private var entries: List<SaveEntry> = emptyList()
    private var users: List<ConsoleUser> = emptyList()

    val isOpen: Boolean
        get() = command?.isConnected == true || data?.isConnected == true

    private fun emit(event: TransferEvent) = listener.onEvent(event)

    private fun log(message: String) = emit(TransferEvent.Log(message))

    fun browse(choice: IdentityChoice, accountId: String, prefixFile: File?) {
        close()
        emit(TransferEvent.Status("launch", "Waking ${console.name} for Data Transfer"))
        val response = Ddp.launchConsole(console.host)
        val (protocol, firmware) = Ddp.discoveryVersions(response)
        firmwareVersion = firmware
        hostId = Ddp.field(response, "host-id") ?: console.hostId
        val host = channelHost(response)
        val requestPort = Ddp.field(response, "host-request-port")?.toIntOrNull()
            ?: console.requestPort.toIntOrNull() ?: 1004
        log("Encrypted channel: $host")
        log("Protocol version: 0x${protocol.toString(16)}; body firmware: 0x${firmware.toString(16)}")

        val prefix = resolvePrefix(choice, accountId, prefixFile)
        if (prefix == null && !hostId.equals(Power.LEGACY_BODY_HOST_ID, ignoreCase = true)) {
            throw DtException(
                "This console needs its owner's PSN account ID for the first browse: the legacy " +
                    "captured identity belongs to ${Power.LEGACY_BODY_HOST_ID}, not to $hostId. " +
                    "Enter the decimal account ID or pair this PS5 once.",
            )
        }
        val hardware = Power.hardwareId(hostId, settings.hardware)
        log("Power request hardware ID: $hardware")
        val body = Power.buildPowerRequestBody(firmware, hardware, hostId, prefix)

        val commandChannel = DtChannel(host, requestPort, deriver(host), version = protocol)
        command = commandChannel
        try {
            emit(TransferEvent.Status("power", "Approving Data Transfer"))
            commandChannel.connect()
            val sub = commandChannel.request(0x91, body)
            var result = commandChannel.response(0x91, sub).result
            if (result == 33L) {
                emit(TransferEvent.PowerRequired("Briefly press the console power button until it beeps"))
                emit(TransferEvent.Status("power", "Waiting for the console power button"))
                result = commandChannel.response(0x91, sub).result
            }
            if (result != 0L) throw DtException(powerResultHint(result, hostId))

            emit(TransferEvent.Status("metadata", "Downloading save metadata"))
            val dataChannel = DtChannel(host, requestPort + 1, deriver(host), version = protocol)
            data = dataChannel
            dataChannel.connect()
            Downloads.downloadMetadata(dataChannel, profileDir) { status -> log(status) }
            refreshInventory()
            emit(TransferEvent.Ready("Select saves to download on the open Data Transfer session"))
        } catch (failure: Exception) {
            close()
            throw failure
        }
    }

    fun downloadEntries(entryIds: List<Long>) {
        val channel = data ?: throw DtException("the Data Transfer session is not open")
        if (entryIds.isEmpty()) throw DtException("select at least one save entry to download")
        entryIds.forEachIndexed { index, id ->
            val entry = entries.firstOrNull { it.id == id }
            emit(TransferEvent.Status("download", "Downloading ${entry?.title ?: id} (${index + 1}/${entryIds.size})"))
            Downloads.downloadEntry(channel, id, profileDir, packageOnly = entry?.kind == EntryKind.APP)
            log("Saved entry $id")
        }
        emit(TransferEvent.Downloaded(entryIds))
        refreshInventory()
        emit(TransferEvent.Ready("Select more saves or finish the session"))
    }

    fun finishAndReboot() {
        val commandChannel = command
        try {
            if (commandChannel?.isConnected == true) {
                log("Sending DisconnectPS5; the console will reboot")
                val sub = commandChannel.request(0x94, ByteArray(8))
                val result = try {
                    commandChannel.response(0x94, sub).result
                } catch (eof: EOFException) {
                    0L
                } catch (reset: SocketException) {
                    0L
                }
                if (result != 0L) throw DtException("DisconnectPS5 failed with result 0x${result.toString(16)}")
            }
            emit(TransferEvent.Done("Disconnect sent. The console is rebooting."))
        } finally {
            close()
        }
    }

    fun close() {
        runCatching { data?.close() }
        runCatching { command?.close() }
        data = null
        command = null
    }

    private fun refreshInventory() {
        val downloaded = Downloads.indexDownloadedManifests(profileDir)
        val db = dbFactory.open(File(profileDir, "metadata.db"))
        try {
            val (foundEntries, foundUsers) = Metadata.readInventory(db, downloaded)
            entries = foundEntries
            users = foundUsers
        } finally {
            runCatching { db.close() }
        }
        emit(TransferEvent.Entries(entries, users))
    }

    private fun resolvePrefix(choice: IdentityChoice, accountId: String, prefixFile: File?): ByteArray? =
        when (choice) {
            IdentityChoice.AccountId -> {
                val trimmed = accountId.trim()
                require(trimmed.matches(Regex("[0-9]+"))) { "account ID must be a decimal string" }
                log("Power request identity: PSN account ID")
                Power.accountHashPrefix(trimmed)
            }
            IdentityChoice.PairingPrefix -> {
                val file = prefixFile ?: throw DtException("no pairing prefix is saved for this console")
                log("Power request identity: paired console")
                Power.loadPrefixFile(file)
            }
            IdentityChoice.MetadataOwner -> {
                log("Power request identity: prior metadata")
                val db = dbFactory.open(File(profileDir, "metadata.db"))
                try {
                    Power.prefixFromMetadata(db)
                        ?: throw DtException("metadata.db has no single online owner to identify with")
                } finally {
                    runCatching { db.close() }
                }
            }
        }

    private fun channelHost(response: String): String {
        if (':' in console.host) return console.host
        if (settings.preferIpv6) {
            val hex = Ddp.field(response, "host-address")
            if (hex != null && hex.length == 32) {
                runCatching {
                    val address = InetAddress.getByAddress(hex.hexToBytes())
                    if (address is Inet6Address) return address.hostAddress
                }
            }
        }
        return console.host
    }

    private fun deriver(host: String): KeyDeriver = when {
        ':' in host -> LocalPskDeriver()
        settings.useRemoteOracle -> HtosDeriver(settings.serverUrl, settings.workerKey)
        else -> OracleDeriver(settings.oracleHost, settings.oraclePort)
    }
}

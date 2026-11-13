package com.garlictransfer.android.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.garlictransfer.android.R
import com.garlictransfer.android.db.AndroidSqlDbFactory
import com.garlictransfer.android.session.ConsoleSession
import com.garlictransfer.android.session.IdentityChoice
import com.garlictransfer.android.session.Profiles
import com.garlictransfer.android.settings.AppSettings
import com.garlictransfer.android.ui.components.KindChip
import com.garlictransfer.android.ui.components.LogView
import com.garlictransfer.android.ui.components.SectionCard
import com.garlictransfer.android.ui.components.formatBytes
import com.garlictransfer.core.ConsoleUser
import com.garlictransfer.core.DiscoveredConsole
import com.garlictransfer.core.PairingOptions
import com.garlictransfer.core.SaveEntry
import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.oracle.HtosDeriver
import com.garlictransfer.core.oracle.OracleDeriver
import com.garlictransfer.core.pair.Pairing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

enum class ConsolePhase { Idle, Connecting, PowerRequired, Browsing, Downloading, Finishing, Done, Failed }

data class ConsoleUiState(
    val console: DiscoveredConsole? = null,
    val phase: ConsolePhase = ConsolePhase.Idle,
    val identity: IdentityChoice = IdentityChoice.AccountId,
    val accountId: String = "",
    val hasPairing: Boolean = false,
    val hasMetadata: Boolean = false,
    val entries: List<SaveEntry> = emptyList(),
    val users: List<ConsoleUser> = emptyList(),
    val selected: Set<Long> = emptySet(),
    val log: List<String> = emptyList(),
    val pairingActive: Boolean = false,
    val error: String? = null,
) {
    val busy: Boolean
        get() = phase == ConsolePhase.Connecting || phase == ConsolePhase.Downloading ||
            phase == ConsolePhase.Finishing || phase == ConsolePhase.PowerRequired
}

class ConsoleViewModel(application: Application) : AndroidViewModel(application) {
    var ui by mutableStateOf(ConsoleUiState())
        private set

    private var session: ConsoleSession? = null
    private var pairingJob: Job? = null

    private val listener = TransferListener { event ->
        when (event) {
            is TransferEvent.Status -> appendLog(event.message)
            is TransferEvent.Log -> appendLog(event.message)
            is TransferEvent.PowerRequired -> {
                appendLog(event.message)
                ui = ui.copy(phase = ConsolePhase.PowerRequired)
            }
            is TransferEvent.Entries -> ui = ui.copy(entries = event.entries, users = event.users, phase = ConsolePhase.Browsing)
            is TransferEvent.Ready -> {
                appendLog(event.message)
                ui = ui.copy(phase = ConsolePhase.Browsing)
            }
            is TransferEvent.Downloaded -> {
                appendLog("Downloaded ${event.entryIds.size} entr${if (event.entryIds.size == 1) "y" else "ies"}")
                ui = ui.copy(selected = ui.selected - event.entryIds.toSet())
            }
            is TransferEvent.Done -> {
                appendLog(event.message)
                ui = ui.copy(phase = ConsolePhase.Done)
            }
            is TransferEvent.Error -> {
                appendLog("Error: ${event.message}")
                ui = ui.copy(phase = ConsolePhase.Failed, error = event.message)
            }
        }
    }

    fun attach(console: DiscoveredConsole) {
        if (ui.console?.hostId == console.hostId) return
        pairingJob?.cancel()
        session?.close()
        session = null
        val profileDir = Profiles.dir(getApplication(), console.hostId)
        val pairing = Profiles.pairingPrefix(getApplication(), console.hostId, console.firmware)
        ui = ConsoleUiState(
            console = console,
            hasPairing = pairing.isFile && pairing.length() == 32L,
            hasMetadata = java.io.File(profileDir, "metadata.db").isFile,
        )
    }

    fun selectIdentity(choice: IdentityChoice) {
        ui = ui.copy(identity = choice, error = null)
    }

    fun updateAccountId(value: String) {
        ui = ui.copy(accountId = value.filter { it.isDigit() }, error = null)
    }

    fun toggleSelected(id: Long) {
        ui = ui.copy(selected = if (id in ui.selected) ui.selected - id else ui.selected + id)
    }

    fun browse() {
        val console = ui.console ?: return
        if (ui.identity == IdentityChoice.AccountId && !ui.accountId.trim().matches(Regex("[0-9]+"))) {
            ui = ui.copy(error = getApplication<Application>().getString(R.string.console_account_invalid))
            return
        }
        val settings = AppSettings.load(getApplication())
        val profileDir = Profiles.dir(getApplication(), console.hostId)
        profileDir.mkdirs()
        val prefix = Profiles.pairingPrefix(getApplication(), console.hostId, console.firmware)
        val activeSession = ConsoleSession(console, settings, profileDir, AndroidSqlDbFactory, listener)
        session = activeSession
        ui = ui.copy(phase = ConsolePhase.Connecting, error = null)
        viewModelScope.launch(Dispatchers.IO) {
            try {
                activeSession.browse(ui.identity, ui.accountId, prefix)
                ui = ui.copy(hasMetadata = true)
            } catch (failure: Exception) {
                val message = failure.message ?: failure.javaClass.simpleName
                appendLog("Error: $message")
                ui = ui.copy(phase = ConsolePhase.Failed, error = message)
            }
        }
    }

    fun downloadSelected() {
        val activeSession = session ?: return
        val ids = ui.selected.sorted()
        if (ids.isEmpty()) return
        ui = ui.copy(phase = ConsolePhase.Downloading, error = null)
        viewModelScope.launch(Dispatchers.IO) {
            try {
                activeSession.downloadEntries(ids)
            } catch (failure: Exception) {
                val message = failure.message ?: failure.javaClass.simpleName
                appendLog("Error: $message")
                ui = ui.copy(phase = ConsolePhase.Failed, error = message)
            }
        }
    }

    fun finishAndReboot() {
        val activeSession = session ?: return
        ui = ui.copy(phase = ConsolePhase.Finishing, error = null)
        viewModelScope.launch(Dispatchers.IO) {
            try {
                activeSession.finishAndReboot()
            } catch (failure: Exception) {
                val message = failure.message ?: failure.javaClass.simpleName
                appendLog("Error: $message")
                ui = ui.copy(phase = ConsolePhase.Failed, error = message)
            }
        }
    }

    fun startPairing() {
        if (ui.pairingActive) return
        val console = ui.console ?: return
        val settings = AppSettings.load(getApplication())
        val prefix = Profiles.pairingPrefix(getApplication(), console.hostId, console.firmware)
        val options = PairingOptions(
            ps5Ip = console.host,
            hostId = console.hostId,
            systemVersion = console.firmware,
            oracleHost = settings.oracleHost,
            oraclePort = settings.oraclePort,
            prefixPath = prefix.absolutePath,
        )
        ui = ui.copy(pairingActive = true, error = null)
        appendLog("[pair] pairing listener starting; select “GarlicTransfer Pairing” on the PS5")
        pairingJob = viewModelScope.launch(Dispatchers.IO) {
            try {
                val deriver = if (settings.useRemoteOracle && settings.serverUrl.isNotBlank()) {
                    HtosDeriver(settings.serverUrl, settings.workerKey)
                } else {
                    OracleDeriver(settings.oracleHost, settings.oraclePort)
                }
                Pairing.pair(options, deriver, listener)
                appendLog("[pair] pairing saved for this PS5; return to its home screen, then browse saves")
                ui = ui.copy(hasPairing = true)
            } catch (failure: Exception) {
                if (!failure.message.isNullOrEmpty()) appendLog("[pair] ${failure.message}")
            } finally {
                ui = ui.copy(pairingActive = false)
            }
        }
    }

    fun cancelPairing() {
        pairingJob?.cancel()
        pairingJob = null
        ui = ui.copy(pairingActive = false)
        appendLog("[pair] cancelled; the listener times out on its own")
    }

    override fun onCleared() {
        pairingJob?.cancel()
        session?.close()
        super.onCleared()
    }

    private fun appendLog(line: String) {
        ui = ui.copy(log = (ui.log + line).takeLast(600))
    }
}

@Composable
fun ConsoleScreen(console: DiscoveredConsole, vm: ConsoleViewModel = viewModel()) {
    LaunchedEffect(console.hostId) { vm.attach(console) }
    val ui = vm.ui
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { ConsoleHeader(console, ui, vm) }

        if (ui.phase == ConsolePhase.Idle || ui.phase == ConsolePhase.Failed) {
            item { IdentityCard(ui, vm) }
        }
        if (ui.phase == ConsolePhase.PowerRequired) {
            item { PowerCard() }
        }
        if (ui.phase == ConsolePhase.Browsing || ui.phase == ConsolePhase.Downloading) {
            item { EntriesCard(ui, vm) }
        }
        if (ui.phase == ConsolePhase.Done) {
            item {
                SectionCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.tertiary)
                        Spacer(Modifier.width(10.dp))
                        Text("Session closed. The console is rebooting.", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
        ui.error?.let { error ->
            item {
                SectionCard {
                    Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        if (ui.busy) {
            item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
        }
        item {
            SectionCard {
                Text(stringResource(R.string.log_title), style = MaterialTheme.typography.titleSmall)
                LogView(ui.log)
            }
        }
    }
}

@Composable
private fun ConsoleHeader(console: DiscoveredConsole, ui: ConsoleUiState, vm: ConsoleViewModel) {
    SectionCard {
        Text(console.name, style = MaterialTheme.typography.titleLarge)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(console.host, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                "firmware ${console.firmware} · host ${console.hostId}",
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (!ui.busy && ui.phase != ConsolePhase.Browsing) {
            Spacer(Modifier.width(0.dp))
            if (ui.pairingActive) {
                OutlinedButton(onClick = vm::cancelPairing, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Outlined.Link, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.console_pair_cancel))
                }
            } else {
                TextButton(onClick = vm::startPairing, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Outlined.Link, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.console_pair))
                }
            }
            Text(
                stringResource(R.string.console_pair_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun IdentityCard(ui: ConsoleUiState, vm: ConsoleViewModel) {
    SectionCard {
        Text(stringResource(R.string.console_identity_title), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.console_identity_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        IdentityOption(
            label = stringResource(R.string.console_identity_account),
            selected = ui.identity == IdentityChoice.AccountId,
            enabled = true,
            onSelect = { vm.selectIdentity(IdentityChoice.AccountId) },
        )
        if (ui.identity == IdentityChoice.AccountId) {
            OutlinedTextField(
                value = ui.accountId,
                onValueChange = vm::updateAccountId,
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text(stringResource(R.string.console_identity_account_hint)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
        }
        IdentityOption(
            label = stringResource(R.string.console_identity_pairing),
            selected = ui.identity == IdentityChoice.PairingPrefix,
            enabled = ui.hasPairing,
            onSelect = { vm.selectIdentity(IdentityChoice.PairingPrefix) },
        )
        IdentityOption(
            label = stringResource(R.string.console_identity_metadata),
            selected = ui.identity == IdentityChoice.MetadataOwner,
            enabled = ui.hasMetadata,
            onSelect = { vm.selectIdentity(IdentityChoice.MetadataOwner) },
        )
        Button(
            onClick = vm::browse,
            modifier = Modifier.fillMaxWidth(),
            enabled = when (ui.identity) {
                IdentityChoice.AccountId -> ui.accountId.isNotBlank()
                IdentityChoice.PairingPrefix -> ui.hasPairing
                IdentityChoice.MetadataOwner -> ui.hasMetadata
            },
        ) {
            Icon(Icons.Outlined.CloudDownload, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(R.string.console_browse))
        }
    }
}

@Composable
private fun IdentityOption(label: String, selected: Boolean, enabled: Boolean, onSelect: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, onClick = onSelect),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = if (enabled) onSelect else null, enabled = enabled)
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
        )
    }
}

@Composable
private fun PowerCard() {
    SectionCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.PowerSettingsNew, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
            Spacer(Modifier.width(12.dp))
            Column {
                Text(stringResource(R.string.console_power_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.console_power_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun EntriesCard(ui: ConsoleUiState, vm: ConsoleViewModel) {
    val interactive = ui.phase == ConsolePhase.Browsing
    SectionCard {
        Text(stringResource(R.string.console_entries_title), style = MaterialTheme.typography.titleMedium)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ui.entries.forEach { entry ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = entry.id in ui.selected,
                            enabled = interactive,
                            onClick = { vm.toggleSelected(entry.id) },
                        )
                        .padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = entry.id in ui.selected,
                        onCheckedChange = if (interactive) ({ vm.toggleSelected(entry.id) }) else null,
                        enabled = interactive,
                    )
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(entry.title, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "${entry.owner} · ${formatBytes(entry.size)}",
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    KindChip(entry.kind)
                    if (entry.downloaded) {
                        Spacer(Modifier.width(6.dp))
                        Icon(
                            Icons.Outlined.CheckCircle,
                            contentDescription = stringResource(R.string.console_downloaded),
                            tint = MaterialTheme.colorScheme.tertiary,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = vm::downloadSelected,
                enabled = interactive && ui.selected.isNotEmpty(),
                modifier = Modifier.weight(1f),
            ) {
                Text(stringResource(R.string.console_download_selected))
            }
            TextButton(onClick = vm::finishAndReboot, enabled = interactive) {
                Icon(Icons.Outlined.RestartAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.console_finish))
            }
        }
    }
}

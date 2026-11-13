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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.garlictransfer.android.R
import com.garlictransfer.android.db.AndroidSqlDbFactory
import com.garlictransfer.android.root.Ports
import com.garlictransfer.android.root.RootHelper
import com.garlictransfer.android.session.Profiles
import com.garlictransfer.android.settings.AppSettings
import com.garlictransfer.android.ui.LocalSnackbarHostState
import com.garlictransfer.android.ui.components.EmptyState
import com.garlictransfer.android.ui.components.LogView
import com.garlictransfer.android.ui.components.RootNoticeDialog
import com.garlictransfer.android.ui.components.SectionCard
import com.garlictransfer.android.ui.components.formatBytes
import com.garlictransfer.android.upload.UploadController
import com.garlictransfer.android.upload.UploadService
import com.garlictransfer.android.upload.UploadState
import com.garlictransfer.android.upload.isActive
import com.garlictransfer.core.ConsoleUser
import com.garlictransfer.core.EntryKind
import com.garlictransfer.core.SaveEntry
import com.garlictransfer.core.channel.Downloads
import com.garlictransfer.core.metadata.Metadata
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

data class UploadUiState(
    val profiles: List<String> = emptyList(),
    val selectedProfile: String? = null,
    val users: List<ConsoleUser> = emptyList(),
    val saves: List<SaveEntry> = emptyList(),
    val selectedUser: String? = null,
    val selectedSaves: Set<Long> = emptySet(),
    val lowPortsBlocked: Boolean = true,
    val showRootDialog: Boolean = false,
    val message: String? = null,
)

class UploadViewModel(application: Application) : AndroidViewModel(application) {
    var ui by mutableStateOf(UploadUiState())
        private set

    fun refresh() {
        val context = getApplication<Application>()
        val profiles = Profiles.available(context)
        val selected = ui.selectedProfile?.takeIf { it in profiles } ?: profiles.firstOrNull()
        var users = emptyList<ConsoleUser>()
        var saves = emptyList<SaveEntry>()
        if (selected != null) {
            runCatching {
                val dir = Profiles.dir(context, selected)
                val db = AndroidSqlDbFactory.open(Profiles.metadata(context, selected))
                try {
                    users = Metadata.readUsers(db)
                    val downloaded = Downloads.indexDownloadedManifests(dir)
                    saves = Metadata.readInventory(db, downloaded).first
                        .filter { it.kind == EntryKind.SAVE && it.downloaded }
                } finally {
                    runCatching { db.close() }
                }
            }
        }
        ui = ui.copy(
            profiles = profiles,
            selectedProfile = selected,
            users = users,
            saves = saves,
            selectedUser = ui.selectedUser?.takeIf { id -> users.any { it.id == id } },
            selectedSaves = ui.selectedSaves.filter { id -> saves.any { it.id == id } }.toSet(),
            lowPortsBlocked = Ports.lowPortsBlocked(),
        )
    }

    fun selectProfile(hostId: String) {
        ui = ui.copy(selectedProfile = hostId, selectedUser = null, selectedSaves = emptySet())
        refresh()
    }

    fun selectUser(id: String) {
        ui = ui.copy(selectedUser = id)
    }

    fun toggleSave(id: Long) {
        ui = ui.copy(selectedSaves = if (id in ui.selectedSaves) ui.selectedSaves - id else ui.selectedSaves + id)
    }

    fun onStartClicked() {
        val settings = AppSettings.load(getApplication())
        val blocked = Ports.lowPortsBlocked()
        ui = ui.copy(lowPortsBlocked = blocked)
        if (blocked || !settings.rootNoticeHidden) {
            ui = ui.copy(showRootDialog = true)
        } else {
            launchService()
        }
    }

    fun onDialogRoot(dontShowAgain: Boolean) {
        persistRootNotice(dontShowAgain)
        ui = ui.copy(showRootDialog = false)
        viewModelScope.launch(Dispatchers.IO) {
            if (!RootHelper.isRootAvailable()) {
                ui = ui.copy(message = getApplication<Application>().getString(R.string.root_not_available))
                return@launch
            }
            if (!RootHelper.allowLowPorts()) {
                ui = ui.copy(message = getApplication<Application>().getString(R.string.root_open_failed))
                return@launch
            }
            UploadController.portsOpenedByUs = true
            launchService()
        }
    }

    fun onDialogTryWithoutRoot(dontShowAgain: Boolean) {
        persistRootNotice(dontShowAgain)
        ui = ui.copy(showRootDialog = false)
        launchService()
    }

    fun onDialogCancel() {
        ui = ui.copy(showRootDialog = false)
    }

    fun stopTransfer() {
        getApplication<Application>().startService(UploadService.stopIntent(getApplication()))
    }

    fun consumeMessage() {
        ui = ui.copy(message = null)
    }

    private fun persistRootNotice(hidden: Boolean) {
        if (!hidden) return
        val context = getApplication<Application>()
        val settings = AppSettings.load(context)
        AppSettings.save(context, settings.copy(rootNoticeHidden = true))
    }

    private fun launchService() {
        val context = getApplication<Application>()
        val profile = ui.selectedProfile ?: return
        val user = ui.users.firstOrNull { it.id == ui.selectedUser } ?: return
        val ids = ui.selectedSaves.sorted()
        if (ids.isEmpty()) return
        UploadController.reset()
        context.startForegroundService(UploadService.startIntent(context, Profiles.dir(context, profile), user.id, user.name, ids))
    }
}

@Composable
fun UploadScreen(vm: UploadViewModel = viewModel()) {
    val ui = vm.ui
    val uploadState by UploadController.state.collectAsState()
    val uploadLog by UploadController.log.collectAsState()
    val snackbar = LocalSnackbarHostState.current
    LaunchedEffect(Unit) { vm.refresh() }
    LaunchedEffect(ui.message) {
        ui.message?.let {
            snackbar.showSnackbar(it)
            vm.consumeMessage()
        }
    }

    if (ui.showRootDialog) {
        RootNoticeDialog(
            onContinueWithRoot = vm::onDialogRoot,
            onTryWithoutRoot = vm::onDialogTryWithoutRoot,
            onCancel = vm::onDialogCancel,
        )
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (ui.lowPortsBlocked) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                ) {
                    Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Shield, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
                        Spacer(Modifier.width(12.dp))
                        Text(
                            stringResource(R.string.upload_banner),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                    }
                }
            }
        }

        if (uploadState.isActive()) {
            item {
                SectionCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.SportsEsports, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.width(10.dp))
                        Text(
                            stringResource(R.string.upload_instructions),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }

        item {
            SectionCard {
                ProfilePicker(
                    profiles = ui.profiles,
                    selected = ui.selectedProfile,
                    onSelect = vm::selectProfile,
                )
            }
        }

        if (ui.users.isNotEmpty()) {
            item {
                SectionCard {
                    Text(stringResource(R.string.upload_pick_user), style = MaterialTheme.typography.titleSmall)
                    ui.users.forEach { user ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .selectable(
                                    selected = ui.selectedUser == user.id,
                                    enabled = !uploadState.isActive(),
                                    onClick = { vm.selectUser(user.id) },
                                ),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(
                                selected = ui.selectedUser == user.id,
                                onClick = if (uploadState.isActive()) null else ({ vm.selectUser(user.id) }),
                            )
                            Text(user.name, style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.width(8.dp))
                            Text(
                                user.id,
                                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }

        if (ui.saves.isNotEmpty()) {
            item {
                SectionCard {
                    Text(stringResource(R.string.upload_pick_saves), style = MaterialTheme.typography.titleSmall)
                    ui.saves.forEach { save ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .selectable(
                                    selected = save.id in ui.selectedSaves,
                                    enabled = !uploadState.isActive(),
                                    onClick = { vm.toggleSave(save.id) },
                                )
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(
                                checked = save.id in ui.selectedSaves,
                                onCheckedChange = if (uploadState.isActive()) null else ({ vm.toggleSave(save.id) }),
                            )
                            Column {
                                Text(save.title, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    "${save.owner} · ${formatBytes(save.size)}",
                                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        } else if (ui.selectedProfile != null || ui.profiles.isEmpty()) {
            item { EmptyState(Icons.Outlined.CloudUpload, stringResource(R.string.upload_empty)) }
        }

        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = vm::onStartClicked,
                    enabled = !uploadState.isActive() && ui.selectedUser != null && ui.selectedSaves.isNotEmpty(),
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(Icons.Outlined.CloudUpload, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.upload_start))
                }
                if (uploadState.isActive()) {
                    OutlinedButton(onClick = vm::stopTransfer) {
                        Text(stringResource(R.string.upload_stop))
                    }
                }
            }
        }

        if (uploadState !is UploadState.Idle) {
            item {
                SectionCard {
                    Text(uploadStateLabel(uploadState), style = MaterialTheme.typography.titleSmall)
                    if (uploadState.isActive()) {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                    if (uploadState is UploadState.PowerRequired) {
                        Text(
                            stringResource(R.string.upload_power_body),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedButton(onClick = { UploadController.signalPower() }, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Outlined.PowerSettingsNew, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(stringResource(R.string.upload_send_power))
                        }
                    }
                    LogView(uploadLog)
                }
            }
        }
    }
}

@Composable
private fun uploadStateLabel(state: UploadState): String = when (state) {
    is UploadState.Idle -> stringResource(R.string.upload_state_idle)
    is UploadState.Preparing -> stringResource(R.string.upload_state_preparing)
    is UploadState.Hosting -> stringResource(R.string.upload_state_hosting)
    is UploadState.PowerRequired -> stringResource(R.string.upload_state_power)
    is UploadState.Transferring -> stringResource(R.string.upload_state_transfer)
    is UploadState.WaitingDisconnect -> stringResource(R.string.upload_state_disconnect)
    is UploadState.RebootRequested -> stringResource(R.string.upload_state_reboot)
    is UploadState.Done -> state.message
    is UploadState.Error -> state.message
}

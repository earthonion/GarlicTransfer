package com.garlictransfer.android.ui.screens

import android.app.Application
import android.net.Uri
import android.provider.DocumentsContract
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.FolderOff
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.garlictransfer.android.R
import com.garlictransfer.android.session.Profiles
import com.garlictransfer.android.ui.LocalSnackbarHostState
import com.garlictransfer.android.ui.components.ConfirmDialog
import com.garlictransfer.android.ui.components.EmptyState
import com.garlictransfer.android.ui.components.SectionCard
import com.garlictransfer.android.ui.components.formatBytes
import com.garlictransfer.core.localsaves.LocalEntry
import com.garlictransfer.core.localsaves.LocalSaves
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

data class ImportRequest(val entryId: Long, val filename: String, val source: Uri)

data class LibraryUiState(
    val profiles: List<String> = emptyList(),
    val selectedProfile: String? = null,
    val entries: List<LocalEntry> = emptyList(),
    val expanded: Set<Long> = emptySet(),
    val pendingImport: ImportRequest? = null,
    val message: String? = null,
)

class LibraryViewModel(application: Application) : AndroidViewModel(application) {
    var ui by mutableStateOf(LibraryUiState())
        private set

    fun refresh() {
        val profiles = Profiles.available(getApplication())
        val selected = ui.selectedProfile?.takeIf { it in profiles } ?: profiles.firstOrNull()
        val entries = selected?.let { profile ->
            runCatching { LocalSaves.inventory(Profiles.dir(getApplication(), profile)) }.getOrDefault(emptyList())
        } ?: emptyList()
        ui = ui.copy(profiles = profiles, selectedProfile = selected, entries = entries)
    }

    fun selectProfile(hostId: String) {
        ui = ui.copy(selectedProfile = hostId, expanded = emptySet())
        refresh()
    }

    fun toggleExpanded(id: Long) {
        ui = ui.copy(expanded = if (id in ui.expanded) ui.expanded - id else ui.expanded + id)
    }

    fun requestImport(entryId: Long, filename: String, source: Uri) {
        ui = ui.copy(pendingImport = ImportRequest(entryId, filename, source))
    }

    fun dismissImport() {
        ui = ui.copy(pendingImport = null)
    }

    fun confirmImport() {
        val request = ui.pendingImport ?: return
        val profile = ui.selectedProfile ?: return
        ui = ui.copy(pendingImport = null)
        viewModelScope.launch(Dispatchers.IO) {
            val context = getApplication<Application>()
            val temp = File(context.cacheDir, "import-${System.nanoTime()}")
            try {
                context.contentResolver.openInputStream(request.source)?.use { input ->
                    temp.outputStream().use { input.copyTo(it) }
                } ?: throw IllegalStateException("could not read the picked file")
                LocalSaves.import(Profiles.dir(context, profile), request.entryId, request.filename, temp)
                ui = ui.copy(message = context.getString(R.string.library_imported))
                refresh()
            } catch (failure: Exception) {
                ui = ui.copy(message = failure.message ?: "import failed")
            } finally {
                temp.delete()
            }
        }
    }

    fun export(entryId: Long, filename: String, tree: Uri) {
        val profile = ui.selectedProfile ?: return
        viewModelScope.launch(Dispatchers.IO) {
            val context = getApplication<Application>()
            val staging = File(context.cacheDir, "export").apply { mkdirs() }
            try {
                val staged = LocalSaves.export(Profiles.dir(context, profile), entryId, filename, staging)
                val resolver = context.contentResolver
                val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
                val created = DocumentsContract.createDocument(resolver, parent, "application/octet-stream", staged.name)
                    ?: throw IllegalStateException("the chosen folder refused the export")
                resolver.openOutputStream(created)?.use { output ->
                    staged.inputStream().use { it.copyTo(output) }
                } ?: throw IllegalStateException("could not write to the chosen folder")
                staged.delete()
                ui = ui.copy(message = context.getString(R.string.library_exported))
            } catch (failure: Exception) {
                ui = ui.copy(message = failure.message ?: "export failed")
            }
        }
    }

    fun consumeMessage() {
        ui = ui.copy(message = null)
    }
}

@Composable
fun LibraryScreen(vm: LibraryViewModel = viewModel()) {
    val ui = vm.ui
    val snackbar = LocalSnackbarHostState.current
    LaunchedEffect(Unit) { vm.refresh() }
    LaunchedEffect(ui.message) {
        ui.message?.let {
            snackbar.showSnackbar(it)
            vm.consumeMessage()
        }
    }

    var pendingExport by androidx.compose.runtime.remember { mutableStateOf<Pair<Long, String>?>(null) }
    val exportLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        val request = pendingExport
        pendingExport = null
        if (uri != null && request != null) vm.export(request.first, request.second, uri)
    }
    var pendingPick by androidx.compose.runtime.remember { mutableStateOf<Pair<Long, String>?>(null) }
    val importLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument(),
    ) { uri ->
        val request = pendingPick
        pendingPick = null
        if (uri != null && request != null) vm.requestImport(request.first, request.second, uri)
    }

    ui.pendingImport?.let { request ->
        ConfirmDialog(
            title = stringResource(R.string.library_replace_title),
            body = stringResource(R.string.library_replace_body, request.filename),
            confirmLabel = stringResource(R.string.library_replace_confirm),
            onConfirm = vm::confirmImport,
            onDismiss = vm::dismissImport,
        )
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionCard {
                Text(stringResource(R.string.library_title), style = MaterialTheme.typography.titleMedium)
                ProfilePicker(
                    profiles = ui.profiles,
                    selected = ui.selectedProfile,
                    onSelect = vm::selectProfile,
                )
            }
        }
        if (ui.entries.isEmpty()) {
            item { EmptyState(Icons.Outlined.FolderOff, stringResource(R.string.library_empty)) }
        }
        items(ui.entries, key = { it.id }) { entry ->
            LibraryEntryCard(
                entry = entry,
                expanded = entry.id in ui.expanded,
                onToggle = { vm.toggleExpanded(entry.id) },
                onExport = { filename ->
                    pendingExport = entry.id to filename
                    exportLauncher.launch(null)
                },
                onReplace = { filename ->
                    pendingPick = entry.id to filename
                    importLauncher.launch(arrayOf("application/octet-stream"))
                },
            )
        }
    }
}

@Composable
fun ProfilePicker(profiles: List<String>, selected: String?, onSelect: (String) -> Unit) {
    var open by androidx.compose.runtime.remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            stringResource(R.string.library_profile),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(12.dp))
        Box {
            OutlinedButton(onClick = { open = true }, enabled = profiles.isNotEmpty()) {
                Text(
                    selected ?: "—",
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                )
                Spacer(Modifier.width(6.dp))
                Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                profiles.forEach { profile ->
                    DropdownMenuItem(
                        text = { Text(profile, fontFamily = FontFamily.Monospace) },
                        onClick = {
                            open = false
                            onSelect(profile)
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun LibraryEntryCard(
    entry: LocalEntry,
    expanded: Boolean,
    onToggle: () -> Unit,
    onExport: (String) -> Unit,
    onReplace: (String) -> Unit,
) {
    SectionCard(onClick = onToggle) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(entry.title, style = MaterialTheme.typography.titleMedium)
                Text(
                    "owner ${entry.owner} · ${entry.files.size} file${if (entry.files.size == 1) "" else "s"} · ${formatBytes(entry.files.sumOf { it.size })}",
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(
                Icons.Outlined.KeyboardArrowDown,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (expanded) {
            entry.files.forEach { file ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 6.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(file.file, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                    Text(
                        "${formatBytes(file.size)} · sha256 ${file.sha256.take(12)}…",
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton(onClick = { onExport(file.file) }) { Text(stringResource(R.string.library_export)) }
                        TextButton(onClick = { onReplace(file.file) }) { Text(stringResource(R.string.library_replace)) }
                    }
                }
            }
        }
    }
}

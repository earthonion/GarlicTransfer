package com.garlictransfer.android.ui.screens

import android.app.Application
import android.content.Context
import android.net.wifi.WifiManager
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material.icons.outlined.WifiTethering
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.garlictransfer.android.ui.components.EmptyState
import com.garlictransfer.android.ui.components.SectionCard
import com.garlictransfer.core.DiscoveredConsole
import com.garlictransfer.core.ddp.Ddp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class DiscoverUiState(
    val searching: Boolean = false,
    val consoles: List<DiscoveredConsole> = emptyList(),
    val manualIp: String = "",
    val searchedOnce: Boolean = false,
    val error: String? = null,
)

class DiscoverViewModel(application: Application) : AndroidViewModel(application) {
    var ui by mutableStateOf(DiscoverUiState())
        private set

    fun updateManualIp(value: String) {
        ui = ui.copy(manualIp = value)
    }

    fun discover(target: String? = null) {
        if (ui.searching) return
        viewModelScope.launch {
            ui = ui.copy(searching = true, error = null)
            try {
                val found = withContext(Dispatchers.IO) {
                    withMulticastLock {
                        if (target.isNullOrBlank()) {
                            Ddp.discover(timeoutMs = 3000)
                        } else {
                            Ddp.discover(timeoutMs = 3000, routes = listOf("" to target.trim()))
                        }
                    }
                }
                val merged = (ui.consoles + found).distinctBy { it.host }
                ui = ui.copy(searching = false, consoles = merged, searchedOnce = true)
            } catch (failure: Exception) {
                ui = ui.copy(searching = false, searchedOnce = true, error = failure.message ?: "discovery failed")
            }
        }
    }

    private fun <T> withMulticastLock(block: () -> T): T {
        val wifi = getApplication<Application>().getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val lock = wifi?.createMulticastLock("garlic-discovery")
        return try {
            lock?.acquire()
            block()
        } finally {
            runCatching { if (lock?.isHeld == true) lock.release() }
        }
    }
}

@Composable
fun DiscoverScreen(onOpenConsole: (DiscoveredConsole) -> Unit, vm: DiscoverViewModel = viewModel()) {
    val ui = vm.ui
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionCard {
                Text(stringResource(R.string.discover_title), style = MaterialTheme.typography.titleMedium)
                FilledTonalButton(
                    onClick = { vm.discover() },
                    enabled = !ui.searching,
                    modifier = Modifier.fillMaxWidth(),
                    colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ),
                ) {
                    if (ui.searching) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Outlined.WifiTethering, contentDescription = null, modifier = Modifier.size(18.dp))
                    }
                    Spacer(Modifier.width(10.dp))
                    Text(stringResource(if (ui.searching) R.string.discover_searching else R.string.discover_button))
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = ui.manualIp,
                        onValueChange = vm::updateManualIp,
                        modifier = Modifier.weight(1f),
                        label = { Text(stringResource(R.string.discover_manual_hint)) },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    )
                    Button(
                        onClick = { vm.discover(ui.manualIp) },
                        enabled = !ui.searching && ui.manualIp.isNotBlank(),
                    ) {
                        Text(stringResource(R.string.discover_manual_add))
                    }
                }
            }
        }
        if (ui.searching) {
            item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
        }
        items(ui.consoles, key = { it.host }) { console ->
            ConsoleCard(console = console, onClick = { onOpenConsole(console) })
        }
        if (!ui.searching && ui.consoles.isEmpty()) {
            item {
                EmptyState(
                    Icons.Outlined.SportsEsports,
                    stringResource(if (ui.searchedOnce) R.string.discover_none_found else R.string.discover_empty),
                )
            }
        }
        ui.error?.let { error ->
            item {
                SectionCard {
                    Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}

@Composable
private fun ConsoleCard(console: DiscoveredConsole, onClick: () -> Unit) {
    SectionCard(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Outlined.SportsEsports,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.width(12.dp))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(console.name, style = MaterialTheme.typography.titleMedium)
                Text(
                    console.host,
                    style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column {
                Text(stringResource(R.string.discover_firmware), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(console.firmware, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
            }
            Column {
                Text(stringResource(R.string.discover_host_id), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(console.hostId, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
            }
        }
    }
}

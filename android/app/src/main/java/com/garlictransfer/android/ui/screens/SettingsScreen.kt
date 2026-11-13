package com.garlictransfer.android.ui.screens

import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewmodel.compose.viewModel
import com.garlictransfer.android.R
import com.garlictransfer.android.settings.AppSettings
import com.garlictransfer.android.ui.LocalSnackbarHostState
import com.garlictransfer.android.ui.components.SectionCard

class SettingsViewModel(application: Application) : AndroidViewModel(application) {
    var useRemoteOracle by mutableStateOf(true)
    var serverUrl by mutableStateOf("")
    var workerKey by mutableStateOf("")
    var oracleHost by mutableStateOf("")
    var oraclePort by mutableStateOf("")
    var hardware by mutableStateOf("0")
    var preferIpv6 by mutableStateOf(false)
    var systemVersion by mutableStateOf("")
    var savedTick by mutableStateOf(false)

    init {
        val settings = AppSettings.load(application)
        useRemoteOracle = settings.useRemoteOracle
        serverUrl = settings.serverUrl
        workerKey = settings.workerKey
        oracleHost = settings.oracleHost
        oraclePort = settings.oraclePort.toString()
        hardware = settings.hardware.toString()
        preferIpv6 = settings.preferIpv6
        systemVersion = settings.systemVersion
    }

    fun save() {
        AppSettings.save(
            getApplication(),
            AppSettings(
                useRemoteOracle = useRemoteOracle,
                serverUrl = serverUrl.trim(),
                workerKey = workerKey.trim(),
                oracleHost = oracleHost.trim(),
                oraclePort = oraclePort.trim().toIntOrNull() ?: 9022,
                hardware = hardware.trim().toIntOrNull()?.coerceIn(0, 3) ?: 0,
                preferIpv6 = preferIpv6,
                systemVersion = systemVersion.trim().ifEmpty { "14200007" },
                rootNoticeHidden = AppSettings.load(getApplication()).rootNoticeHidden,
            ),
        )
        savedTick = true
    }

    fun consumeSaved() {
        savedTick = false
    }
}

@Composable
fun SettingsScreen(vm: SettingsViewModel = viewModel()) {
    val snackbar = LocalSnackbarHostState.current
    val savedText = stringResource(R.string.settings_saved)
    LaunchedEffect(vm.savedTick) {
        if (vm.savedTick) {
            snackbar.showSnackbar(savedText)
            vm.consumeSaved()
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            SectionCard {
                Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleMedium)
                SettingsToggle(
                    label = stringResource(R.string.settings_remote_oracle),
                    checked = vm.useRemoteOracle,
                    onChange = { vm.useRemoteOracle = it },
                )
                SettingsField(
                    value = vm.serverUrl,
                    onChange = { vm.serverUrl = it },
                    label = stringResource(R.string.settings_server_url),
                    enabled = vm.useRemoteOracle,
                )
                SettingsField(
                    value = vm.workerKey,
                    onChange = { vm.workerKey = it },
                    label = stringResource(R.string.settings_worker_key),
                    enabled = vm.useRemoteOracle,
                    secret = true,
                )
            }
        }
        item {
            SectionCard {
                SettingsField(
                    value = vm.oracleHost,
                    onChange = { vm.oracleHost = it },
                    label = stringResource(R.string.settings_oracle_host),
                    enabled = !vm.useRemoteOracle,
                )
                SettingsField(
                    value = vm.oraclePort,
                    onChange = { vm.oraclePort = it.filter(Char::isDigit) },
                    label = stringResource(R.string.settings_oracle_port),
                    enabled = !vm.useRemoteOracle,
                    numeric = true,
                )
            }
        }
        item {
            SectionCard {
                SettingsField(
                    value = vm.hardware,
                    onChange = { vm.hardware = it.filter(Char::isDigit).take(1) },
                    label = stringResource(R.string.settings_hardware),
                    numeric = true,
                )
                SettingsField(
                    value = vm.systemVersion,
                    onChange = { vm.systemVersion = it },
                    label = stringResource(R.string.settings_system_version),
                )
                SettingsToggle(
                    label = stringResource(R.string.settings_prefer_ipv6),
                    checked = vm.preferIpv6,
                    onChange = { vm.preferIpv6 = it },
                )
                Button(onClick = vm::save, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.settings_save))
                }
            }
        }
    }
}

@Composable
private fun SettingsField(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    enabled: Boolean = true,
    secret: Boolean = false,
    numeric: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
    )
}

@Composable
private fun SettingsToggle(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

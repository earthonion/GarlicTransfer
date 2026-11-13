package com.garlictransfer.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.filled.CloudUpload
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WifiTethering
import androidx.compose.material.icons.outlined.CloudUpload
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.WifiTethering
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.garlictransfer.android.R
import com.garlictransfer.android.ui.screens.ConsoleScreen
import com.garlictransfer.android.ui.screens.DiscoverScreen
import com.garlictransfer.android.ui.screens.LibraryScreen
import com.garlictransfer.android.ui.screens.SettingsScreen
import com.garlictransfer.android.ui.screens.UploadScreen
import com.garlictransfer.android.ui.theme.GarlicTransferTheme
import com.garlictransfer.android.upload.UploadController
import com.garlictransfer.android.upload.isActive

val LocalSnackbarHostState = compositionLocalOf<SnackbarHostState> { error("no snackbar host provided") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GarlicApp(appViewModel: AppViewModel = viewModel()) {
    val snackbarHostState = remember { SnackbarHostState() }
    val uploadState by UploadController.state.collectAsState()
    GarlicTransferTheme {
        androidx.compose.runtime.CompositionLocalProvider(LocalSnackbarHostState provides snackbarHostState) {
            Scaffold(
                topBar = {
                    CenterAlignedTopAppBar(
                        title = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Icon(
                                    painterResource(R.drawable.ic_launcher),
                                    contentDescription = null,
                                    modifier = Modifier.size(26.dp),
                                    tint = androidx.compose.ui.graphics.Color.Unspecified,
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge)
                            }
                        },
                        navigationIcon = {
                            if (appViewModel.screen is Screen.Console) {
                                IconButton(onClick = appViewModel::closeConsole) {
                                    Icon(
                                        Icons.AutoMirrored.Outlined.ArrowBack,
                                        contentDescription = stringResource(R.string.console_back),
                                    )
                                }
                            }
                        },
                        colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                            containerColor = MaterialTheme.colorScheme.background,
                        ),
                    )
                },
                bottomBar = {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        val tabs = listOf(
                            Triple(Screen.Discover, R.string.nav_discover, Icons.Outlined.WifiTethering to Icons.Filled.WifiTethering),
                            Triple(Screen.Library, R.string.nav_library, Icons.Outlined.Folder to Icons.Filled.Folder),
                            Triple(Screen.Upload, R.string.nav_upload, Icons.Outlined.CloudUpload to Icons.Filled.CloudUpload),
                            Triple(Screen.Settings, R.string.nav_settings, Icons.Outlined.Settings to Icons.Filled.Settings),
                        )
                        tabs.forEach { (target, label, icons) ->
                            val selected = appViewModel.screen == target ||
                                (target == Screen.Discover && appViewModel.screen is Screen.Console)
                            NavigationBarItem(
                                selected = selected,
                                onClick = { appViewModel.navigate(target) },
                                label = { Text(stringResource(label)) },
                                colors = androidx.compose.material3.NavigationBarItemDefaults.colors(
                                    indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                                    selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                                ),
                                icon = {
                                    val icon = if (selected) icons.second else icons.first
                                    if (target == Screen.Upload && uploadState.isActive()) {
                                        BadgedBox(badge = { Badge() }) {
                                            Icon(icon, contentDescription = null)
                                        }
                                    } else {
                                        Icon(icon, contentDescription = null)
                                    }
                                },
                            )
                        }
                    }
                },
                snackbarHost = { SnackbarHost(snackbarHostState) },
                containerColor = MaterialTheme.colorScheme.background,
            ) { padding ->
                AnimatedContent(
                    targetState = appViewModel.screen,
                    modifier = Modifier.fillMaxSize().padding(padding),
                    transitionSpec = {
                        (fadeIn() + slideInVertically { it / 30 }).togetherWith(fadeOut())
                    },
                    label = "screen",
                ) { screen ->
                    when (screen) {
                        is Screen.Discover -> DiscoverScreen(onOpenConsole = appViewModel::openConsole)
                        is Screen.Console -> ConsoleScreen(screen.console)
                        is Screen.Library -> LibraryScreen()
                        is Screen.Upload -> UploadScreen()
                        is Screen.Settings -> SettingsScreen()
                    }
                }
            }
        }
    }
}

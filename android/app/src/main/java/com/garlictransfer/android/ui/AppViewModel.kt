package com.garlictransfer.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import com.garlictransfer.core.DiscoveredConsole

sealed interface Screen {
    data object Discover : Screen
    data class Console(val console: DiscoveredConsole) : Screen
    data object Library : Screen
    data object Upload : Screen
    data object Settings : Screen
}

class AppViewModel : ViewModel() {
    var screen by mutableStateOf<Screen>(Screen.Discover)
        private set

    fun navigate(target: Screen) {
        screen = target
    }

    fun openConsole(console: DiscoveredConsole) {
        screen = Screen.Console(console)
    }

    fun closeConsole() {
        screen = Screen.Discover
    }
}

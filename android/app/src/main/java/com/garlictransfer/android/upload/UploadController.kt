package com.garlictransfer.android.upload

import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.source.UploadServer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

sealed interface UploadState {
    data object Idle : UploadState
    data object Preparing : UploadState
    data object Hosting : UploadState
    data object PowerRequired : UploadState
    data object Transferring : UploadState
    data object WaitingDisconnect : UploadState
    data object RebootRequested : UploadState
    data class Done(val message: String) : UploadState
    data class Error(val message: String) : UploadState
}

fun UploadState.isActive(): Boolean = when (this) {
    is UploadState.Idle, is UploadState.Done, is UploadState.Error -> false
    else -> true
}

/**
 * Bridge between the foreground UploadService and the UI. The service owns the
 * UploadServer; this singleton owns the observable state. Mirrors the lifecycle
 * markers the desktop reads from the source emulator's log (electron/main.cjs).
 */
object UploadController {
    private const val MAX_LOG_LINES = 600

    private val _log = MutableStateFlow<List<String>>(emptyList())
    val log: StateFlow<List<String>> = _log.asStateFlow()

    private val _state = MutableStateFlow<UploadState>(UploadState.Idle)
    val state: StateFlow<UploadState> = _state.asStateFlow()

    @Volatile
    var server: UploadServer? = null
        private set

    @Volatile
    var portsOpenedByUs: Boolean = false

    @Volatile
    private var transferFinished = false

    @Volatile
    private var rebootRequested = false

    @Volatile
    private var rebootAuthenticated = false

    @Synchronized
    fun attach(server: UploadServer) {
        this.server = server
    }

    @Synchronized
    fun detach(server: UploadServer) {
        if (this.server === server) this.server = null
    }

    fun reset() {
        _log.value = emptyList()
        _state.value = UploadState.Idle
        transferFinished = false
        rebootRequested = false
        rebootAuthenticated = false
    }

    fun setState(state: UploadState) {
        _state.value = state
    }

    fun appendLog(line: String) {
        _log.value = (_log.value + line).takeLast(MAX_LOG_LINES)
    }

    fun signalPower() {
        server?.signalPower()
        appendLog("[power] power signal sent — waiting for the console")
        if (_state.value is UploadState.PowerRequired) _state.value = UploadState.Hosting
    }

    /** Stops the server; blocks while its threads join. Call off the main thread. */
    fun stopServer() {
        val current = synchronized(this) {
            val s = server
            server = null
            s
        }
        current?.let { runCatching { it.stop() } }
    }

    fun listener(): TransferListener = TransferListener { event ->
        when (event) {
            is TransferEvent.Log -> handleLog(event.message)
            is TransferEvent.Status -> {
                appendLog(event.message)
                if (event.step == "upload") _state.value = UploadState.Hosting
            }
            is TransferEvent.PowerRequired -> {
                appendLog("[power] ${event.message}")
                _state.value = UploadState.PowerRequired
            }
            is TransferEvent.Done -> {
                appendLog(event.message)
                _state.value = UploadState.Done(event.message)
            }
            is TransferEvent.Error -> {
                appendLog("Error: ${event.message}")
                _state.value = UploadState.Error(event.message)
            }
            else -> appendLog(event.toString())
        }
    }

    private fun handleLog(message: String) {
        appendLog(message)
        val line = message.lowercase()
        if (line.contains("connection from") && _state.value.let { it is UploadState.Hosting || it is UploadState.PowerRequired }) {
            _state.value = UploadState.Transferring
        }
        if (line.contains("cmd=0xb3")) {
            transferFinished = true
            _state.value = UploadState.WaitingDisconnect
        }
        if (line.contains("response complete cmd=0xb0")) {
            rebootRequested = true
            _state.value = UploadState.RebootRequested
        }
        if (rebootRequested && line.contains("response complete cmd=0x93")) {
            rebootAuthenticated = true
            appendLog("Reboot authentication acknowledged. Finishing the transfer.")
        }
        if (transferFinished && !rebootRequested && line.contains("response complete cmd=0x94")) {
            _state.value = UploadState.Done("Save upload completed. The client may reboot to finish.")
        }
        if (rebootAuthenticated && line.contains("[cmd] session ended:")) {
            _state.value = UploadState.Done("Save upload and reboot authentication completed.")
        }
    }
}

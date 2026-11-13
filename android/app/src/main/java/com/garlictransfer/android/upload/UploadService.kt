package com.garlictransfer.android.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.garlictransfer.android.MainActivity
import com.garlictransfer.android.R
import com.garlictransfer.android.db.AndroidSqlDbFactory
import com.garlictransfer.android.root.RootHelper
import com.garlictransfer.android.settings.AppSettings
import com.garlictransfer.core.UploadConfig
import com.garlictransfer.core.metadata.Metadata
import com.garlictransfer.core.oracle.HtosDeriver
import com.garlictransfer.core.source.UploadServer
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground host for the emulated "source console". Regenerates the filtered upload
 * metadata, binds the Data Transfer ports via UploadServer, and reports through
 * UploadController. Stops itself on a terminal state or on ACTION_STOP.
 */
class UploadService : Service() {

    companion object {
        const val ACTION_STOP = "com.garlictransfer.android.upload.STOP"
        private const val EXTRA_PROFILE = "profile"
        private const val EXTRA_USER_ID = "userId"
        private const val EXTRA_USER_NAME = "userName"
        private const val EXTRA_ENTRY_IDS = "entryIds"
        private const val CHANNEL_ID = "transfers"
        private const val NOTIFICATION_ID = 1007

        fun startIntent(context: Context, profileDir: File, userId: String, userName: String, entryIds: List<Long>): Intent =
            Intent(context, UploadService::class.java)
                .putExtra(EXTRA_PROFILE, profileDir.absolutePath)
                .putExtra(EXTRA_USER_ID, userId)
                .putExtra(EXTRA_USER_NAME, userName)
                .putExtra(EXTRA_ENTRY_IDS, entryIds.toLongArray())

        fun stopIntent(context: Context): Intent = Intent(context, UploadService::class.java).setAction(ACTION_STOP)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var server: UploadServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null || intent.action == ACTION_STOP) {
            stopHosting()
            return START_NOT_STICKY
        }
        startForegroundNotification()
        val profile = intent.getStringExtra(EXTRA_PROFILE).orEmpty()
        val userId = intent.getStringExtra(EXTRA_USER_ID).orEmpty()
        val userName = intent.getStringExtra(EXTRA_USER_NAME).orEmpty()
        val entryIds = intent.getLongArrayExtra(EXTRA_ENTRY_IDS)?.toList().orEmpty()
        scope.launch { host(profile, userId, userName, entryIds) }
        scope.launch {
            UploadController.state.collect { state ->
                if (state is UploadState.Done || state is UploadState.Error) {
                    delay(400)
                    stopHosting()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopHosting()
        scope.cancel()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        stopHosting()
        super.onTaskRemoved(rootIntent)
    }

    private fun host(profile: String, userId: String, userName: String, entryIds: List<Long>) {
        try {
            UploadController.setState(UploadState.Preparing)
            val settings = AppSettings.load(this)
            val profileDir = File(profile)
            val sourceMetadata = File(profileDir, "metadata.db")
            if (!sourceMetadata.isFile) throw IllegalStateException("this profile has no metadata.db; browse the console first")
            if (entryIds.isEmpty()) throw IllegalStateException("select at least one downloaded save to upload")
            val uploadDir = File(profileDir, "upload")
            val uploadMetadata = File(uploadDir, "metadata.db")
            val uploadManifest = File(uploadDir, "manifest.json")
            Metadata.createFilteredMetadata(
                AndroidSqlDbFactory,
                uploadMetadata,
                sourceMetadata,
                userId,
                userName,
                entryIds,
                profileDir,
                uploadManifest,
            )
            UploadController.appendLog("Upload metadata ready: ${entryIds.size} entr${if (entryIds.size == 1) "y" else "ies"} for $userName")
            val config = UploadConfig(
                metadataPath = uploadMetadata.absolutePath,
                assetsPath = profileDir.absolutePath,
                manifestPath = uploadManifest.absolutePath,
                oracleHost = settings.oracleHost,
                oraclePort = settings.oraclePort,
                systemVersion = settings.systemVersion,
                useLocalPsk = false,
            )
            val deriver = if (settings.useRemoteOracle && settings.serverUrl.isNotBlank()) {
                HtosDeriver(settings.serverUrl, settings.workerKey)
            } else {
                null
            }
            val newServer = UploadServer(config, AndroidSqlDbFactory, UploadController.listener(), deriver)
            server = newServer
            UploadController.attach(newServer)
            newServer.start()
        } catch (failure: Exception) {
            UploadController.appendLog("Error: ${failure.message ?: failure.javaClass.simpleName}")
            UploadController.setState(UploadState.Error(failure.message ?: "the upload server failed to start"))
        }
    }

    private fun stopHosting() {
        val current = server
        server = null
        scope.launch {
            if (current != null) {
                UploadController.stopServer()
            }
            if (UploadController.portsOpenedByUs) {
                UploadController.portsOpenedByUs = false
                RootHelper.restoreDefaultPortFloor()
            }
            ServiceCompat.stopForeground(this@UploadService, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun startForegroundNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW),
        )
        val intent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(getString(R.string.notification_hosting))
            .setContentText(getString(R.string.notification_text))
            .setContentIntent(intent)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
        )
    }
}

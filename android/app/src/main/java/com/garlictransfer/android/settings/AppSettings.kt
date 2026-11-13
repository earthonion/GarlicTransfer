package com.garlictransfer.android.settings

import android.content.Context
import java.io.File
import java.util.Properties

data class AppSettings(
    val useRemoteOracle: Boolean = true,
    val serverUrl: String = "https://garlicsaves.com",
    val workerKey: String = "",
    val oracleHost: String = "192.168.0.125",
    val oraclePort: Int = 9022,
    val hardware: Int = 0,
    val preferIpv6: Boolean = false,
    val systemVersion: String = "14200007",
    val rootNoticeHidden: Boolean = false,
) {
    fun toProperties(): Properties = Properties().apply {
        setProperty("useRemoteOracle", useRemoteOracle.toString())
        setProperty("serverUrl", serverUrl)
        setProperty("workerKey", workerKey)
        setProperty("oracleHost", oracleHost)
        setProperty("oraclePort", oraclePort.toString())
        setProperty("hardware", hardware.toString())
        setProperty("preferIpv6", preferIpv6.toString())
        setProperty("systemVersion", systemVersion)
        setProperty("rootNoticeHidden", rootNoticeHidden.toString())
    }

    companion object {
        private fun file(context: Context): File = File(context.filesDir, "config.ini")

        fun load(context: Context): AppSettings {
            val target = file(context.applicationContext)
            if (!target.isFile) return AppSettings()
            val props = Properties()
            runCatching { target.inputStream().use(props::load) }
            return AppSettings(
                useRemoteOracle = props.getProperty("useRemoteOracle", "true").toBoolean(),
                serverUrl = props.getProperty("serverUrl", "https://garlicsaves.com"),
                workerKey = props.getProperty("workerKey", ""),
                oracleHost = props.getProperty("oracleHost", "192.168.0.125"),
                oraclePort = props.getProperty("oraclePort", "9022").toIntOrNull() ?: 9022,
                hardware = props.getProperty("hardware", "0").toIntOrNull() ?: 0,
                preferIpv6 = props.getProperty("preferIpv6", "false").toBoolean(),
                systemVersion = props.getProperty("systemVersion", "14200007"),
                rootNoticeHidden = props.getProperty("rootNoticeHidden", "false").toBoolean(),
            )
        }

        fun save(context: Context, settings: AppSettings) {
            val target = file(context.applicationContext)
            target.parentFile?.mkdirs()
            target.outputStream().use { settings.toProperties().store(it, "GarlicTransfer settings") }
        }
    }
}

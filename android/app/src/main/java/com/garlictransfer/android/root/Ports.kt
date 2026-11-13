package com.garlictransfer.android.root

import com.topjohnwu.superuser.Shell
import java.io.File
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * The upload path binds TCP 1004/1005 and UDP 1006. Ports below
 * /proc/sys/net/ipv4/ip_unprivileged_port_start (1024 on stock kernels) are privileged,
 * so on most devices upload needs root; some kernels (and emulators) allow low ports directly.
 */
object Ports {
    const val COMMAND_PORT = 1004
    const val DATA_PORT = 1005
    const val DISCOVERY_PORT = 1006
    const val HIGHEST_NEEDED = DISCOVERY_PORT

    fun unprivilegedPortStart(): Int? = runCatching {
        File("/proc/sys/net/ipv4/ip_unprivileged_port_start").readText().trim().toInt()
    }.getOrNull()

    /** True when the needed ports are privileged for this app (root required to bind them). */
    fun lowPortsBlocked(): Boolean {
        // SELinux denies untrusted apps the /proc sysctl read, so fall back to a trial bind.
        unprivilegedPortStart()?.let { return it > HIGHEST_NEEDED }
        return !probeLowPorts()
    }

    private fun probeLowPorts(): Boolean {
        return try {
            ServerSocket().use { it.bind(InetSocketAddress(COMMAND_PORT)) }
            ServerSocket().use { it.bind(InetSocketAddress(DATA_PORT)) }
            DatagramSocket(null).use { it.bind(InetSocketAddress(DISCOVERY_PORT)) }
            true
        } catch (failure: Exception) {
            val message = failure.message ?: return false
            // EADDRINUSE means the kernel allows the port (often our own server holding it).
            message.contains("EADDRINUSE") || message.contains("Address already in use")
        }
    }
}

object RootHelper {
    fun isRootAvailable(): Boolean = runCatching { Shell.isAppGrantedRoot() == true }.getOrDefault(false)

    /**
     * Lowers the unprivileged-port floor to 1004 via a root shell so the upload
     * server can bind TCP 1004/1005 and UDP 1006. Resets on reboot.
     */
    fun allowLowPorts(): Boolean = runCatching {
        Shell.cmd("sysctl -w net.ipv4.ip_unprivileged_port_start=${Ports.COMMAND_PORT}").exec().isSuccess
    }.getOrDefault(false)

    fun restoreDefaultPortFloor(): Boolean = runCatching {
        Shell.cmd("sysctl -w net.ipv4.ip_unprivileged_port_start=1024").exec().isSuccess
    }.getOrDefault(false)
}

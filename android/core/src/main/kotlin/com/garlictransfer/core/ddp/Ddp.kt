package com.garlictransfer.core.ddp

import com.garlictransfer.core.DiscoveredConsole
import com.garlictransfer.core.DtException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException

object Ddp {
    const val DEFAULT_PORT = 1006

    const val SRCH = "SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030000\n"
    const val LAUNCH4 = "LAUNCH4 * HTTP/1.1\ndevice-discovery-protocol-version:00030000\n"

    private const val RECEIVE_BUFFER_SIZE = 4096
    private const val POLL_INTERVAL_MS = 200
    private val lineSplit = Regex("\r?\n")
    private val firmwareHex = Regex("[0-9a-fA-F]{8}")

    /**
     * Broadcasts/directs SRCH probes and collects consoles until [timeoutMs] elapses.
     * [routes] are (bindIp, targetIp) pairs for directed probes; broadcast used when empty.
     */
    fun discover(
        timeoutMs: Int = 2000,
        port: Int = DEFAULT_PORT,
        broadcastAddress: String = "255.255.255.255",
        routes: List<Pair<String, String>> = emptyList(),
    ): List<DiscoveredConsole> {
        val effectiveRoutes = routes.ifEmpty { listOf("" to broadcastAddress) }
        val probe = SRCH.toByteArray(Charsets.US_ASCII)
        val sockets = mutableListOf<DatagramSocket>()
        try {
            for ((bind, target) in effectiveRoutes) {
                val socket = DatagramSocket(null)
                try {
                    socket.broadcast = true
                    socket.soTimeout = POLL_INTERVAL_MS
                    socket.bind(if (bind.isEmpty()) InetSocketAddress(0) else InetSocketAddress(bind, 0))
                    socket.send(DatagramPacket(probe, probe.size, InetAddress.getByName(target), port))
                } catch (failure: Exception) {
                    runCatching { socket.close() }
                    continue
                }
                sockets.add(socket)
            }
            val consoles = LinkedHashMap<String, DiscoveredConsole>()
            val deadline = System.nanoTime() + timeoutMs.toLong() * 1_000_000L
            while (sockets.isNotEmpty() && System.nanoTime() < deadline) {
                for (socket in sockets) {
                    while (System.nanoTime() < deadline) {
                        val packet = DatagramPacket(ByteArray(RECEIVE_BUFFER_SIZE), RECEIVE_BUFFER_SIZE)
                        try {
                            socket.receive(packet)
                        } catch (timeout: SocketTimeoutException) {
                            break
                        }
                        val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        if (text.startsWith("HTTP/1.1")) {
                            val host = packet.address?.hostAddress ?: continue
                            consoles[host] = parseConsole(text, host)
                        }
                    }
                }
            }
            return consoles.values.toList()
        } finally {
            for (socket in sockets) runCatching { socket.close() }
        }
    }

    /**
     * SRCH (+ LAUNCH4 unless [skipLaunch]) against one host; returns the raw discovery response.
     * A LAUNCH4 timeout is tolerated (the existing Data Transfer listener is reused).
     */
    fun launchConsole(host: String, port: Int = DEFAULT_PORT, skipLaunch: Boolean = false, timeoutMs: Int = 5000): String {
        val target = InetAddress.getByName(host)
        val socket = DatagramSocket()
        try {
            socket.soTimeout = timeoutMs
            val probe = SRCH.toByteArray(Charsets.US_ASCII)
            socket.send(DatagramPacket(probe, probe.size, target, port))
            val discovery = receiveText(socket)
            if (!discovery.startsWith("HTTP/1.1 200")) throw DtException("discovery failed: $discovery")
            if (skipLaunch) return discovery
            val launch = LAUNCH4.toByteArray(Charsets.US_ASCII)
            socket.send(DatagramPacket(launch, launch.size, target, port))
            val launchResponse = try {
                receiveText(socket)
            } catch (timeout: SocketTimeoutException) {
                return discovery
            }
            if (!launchResponse.startsWith("HTTP/1.1 200") && !launchResponse.startsWith("HTTP/1.1 620")) {
                throw DtException("launch failed: $launchResponse")
            }
            return discovery + launchResponse
        } finally {
            runCatching { socket.close() }
        }
    }

    /** Parses `system-version:` into (protocolVersion, firmwareVersion), e.g. "13600007" -> (0x130, 0x13600007). */
    fun discoveryVersions(response: String): Pair<Int, Int> {
        for (line in response.split(lineSplit)) {
            if (line.startsWith("system-version:")) {
                val firmware = line.substringAfter(':')
                if (!firmware.matches(firmwareHex)) break
                return (firmware.substring(0, 2) + "0").toInt(16) to firmware.toInt(16)
            }
        }
        throw DtException("discovery response has no valid system-version")
    }

    /** Value of a `name:value` line in a DDP response, or null. */
    fun field(response: String, name: String): String? {
        var value: String? = null
        for (line in response.split(lineSplit)) {
            val colon = line.indexOf(':')
            if (colon >= 0 && line.substring(0, colon) == name) value = line.substring(colon + 1)
        }
        return value
    }

    private fun parseConsole(response: String, host: String): DiscoveredConsole {
        val fields = LinkedHashMap<String, String>()
        for (line in response.split(lineSplit)) {
            val colon = line.indexOf(':')
            if (colon >= 0) fields[line.substring(0, colon)] = line.substring(colon + 1)
        }
        return DiscoveredConsole(
            host = host,
            name = fields["host-name"] ?: "PS5",
            type = fields["host-type"] ?: "PS5",
            hostId = fields["host-id"] ?: "",
            firmware = fields["system-version"] ?: "unknown",
            requestPort = fields["host-request-port"] ?: "",
            network = fields["host-network"] ?: "",
            address = fields["host-address"] ?: "",
        )
    }

    private fun receiveText(socket: DatagramSocket): String {
        val packet = DatagramPacket(ByteArray(RECEIVE_BUFFER_SIZE), RECEIVE_BUFFER_SIZE)
        socket.receive(packet)
        return String(packet.data, 0, packet.length, Charsets.UTF_8)
    }
}

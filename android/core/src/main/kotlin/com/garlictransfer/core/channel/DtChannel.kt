package com.garlictransfer.core.channel

import com.garlictransfer.core.DtException
import com.garlictransfer.core.crypto.BODY_CHUNK_SIZE
import com.garlictransfer.core.crypto.CommandHeader
import com.garlictransfer.core.crypto.RecordLayer
import com.garlictransfer.core.crypto.SessionKeys
import com.garlictransfer.core.oracle.KeyDeriver
import com.garlictransfer.core.util.recvExact
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom

data class CommandResult(val result: Long, val body: ByteArray) {
    override fun equals(other: Any?): Boolean =
        other is CommandResult && result == other.result && body.contentEquals(other.body)

    override fun hashCode(): Int = result.hashCode()
}

/**
 * Client side of one encrypted Data Transfer channel (AE handshake, then
 * 16-byte command headers + record-chunked bodies).
 */
class DtChannel(
    val host: String,
    val port: Int,
    private val deriver: KeyDeriver,
    val version: Int = 0x130,
    private val connectTimeoutMs: Int = 10_000,
    private val ioTimeoutMs: Int = 310_000,
) : AutoCloseable {

    private val random = SecureRandom()
    private var socket: Socket? = null
    private var layer: RecordLayer? = null
    private var keys: SessionKeys? = null
    private var sendSequence = 0L
    private var recvSequence = 0L
    private var sub = 1

    val isConnected: Boolean
        get() = socket?.let { it.isConnected && !it.isClosed } == true

    /** Performs the TCP connect, 64-byte AE exchange, key derivation, and the empty seq-0 completion record. */
    @Synchronized
    fun connect() {
        if (isConnected) return
        val newSocket = Socket()
        try {
            newSocket.connect(InetSocketAddress(host, port), connectTimeoutMs)
            newSocket.soTimeout = ioTimeoutMs
            val clientValue = ByteArray(16).also { random.nextBytes(it) }
            val output = newSocket.getOutputStream()
            output.write(clientValue + ByteArray(48))
            output.flush()
            val serverValue = recvExact(newSocket.getInputStream(), 64).copyOf(16)
            val derived = deriver.derive(clientValue, serverValue)
            val newLayer = RecordLayer(newSocket.getInputStream(), output)
            newLayer.send(derived.sendKey, derived.sendNoncePrefix, 0, ByteArray(0))
            socket = newSocket
            keys = derived
            layer = newLayer
            sendSequence = 1
            recvSequence = 0
            sub = 1
        } catch (failure: Exception) {
            runCatching { newSocket.close() }
            throw failure
        }
    }

    /** Sends a command header + record-chunked body; returns the sub id to match responses against. */
    @Synchronized
    fun request(cmd: Int, body: ByteArray = ByteArray(0)): Int {
        val activeLayer = layer ?: throw DtException("channel is not connected")
        val activeKeys = keys ?: throw DtException("channel is not connected")
        val usedSub = sub
        sub = (sub + 1) and 0xFF
        activeLayer.send(
            activeKeys.sendKey,
            activeKeys.sendNoncePrefix,
            sendSequence,
            CommandHeader(cmd, usedSub, version, 0, body.size.toLong()).pack(),
        )
        sendSequence++
        var offset = 0
        while (offset < body.size) {
            val end = minOf(offset + BODY_CHUNK_SIZE, body.size)
            activeLayer.send(activeKeys.sendKey, activeKeys.sendNoncePrefix, sendSequence, body.copyOfRange(offset, end))
            sendSequence++
            offset = end
        }
        return usedSub
    }

    /** Reads one command response (header record + body records) for [cmd]/[sub]. */
    @Synchronized
    fun response(cmd: Int, sub: Int): CommandResult {
        val headerBytes = recvRecord()
        if (headerBytes.size != CommandHeader.SIZE) {
            throw DtException("unexpected response record: ${headerBytes.size} bytes")
        }
        val header = CommandHeader.parse(headerBytes)
        if (header.cmd != cmd || header.sub != sub) {
            throw DtException(
                "response mismatch: 0x${header.cmd.toString(16)}/${header.sub} != 0x${cmd.toString(16)}/$sub",
            )
        }
        val body = ByteArrayOutputStream()
        while (body.size().toLong() < header.bodySize) {
            val chunk = recvRecord()
            if (chunk.size.toLong() > header.bodySize - body.size()) {
                throw DtException("body exceeds declared size: ${body.size() + chunk.size} > ${header.bodySize}")
            }
            body.write(chunk)
        }
        return CommandResult(header.result, body.toByteArray())
    }

    /** Next record from the console in receive order; used by the GFP5 entry stream in Downloads. */
    @Synchronized
    internal fun recvRecord(): ByteArray {
        val activeLayer = layer ?: throw DtException("channel is not connected")
        val activeKeys = keys ?: throw DtException("channel is not connected")
        val data = activeLayer.recv(activeKeys.recvKey, activeKeys.recvNoncePrefix, recvSequence)
        recvSequence++
        return data
    }

    @Synchronized
    override fun close() {
        val current = socket
        socket = null
        layer = null
        keys = null
        if (current != null) runCatching { current.close() }
    }
}

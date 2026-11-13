package com.garlictransfer.core.source

import com.garlictransfer.core.TransferEvent
import com.garlictransfer.core.TransferListener
import com.garlictransfer.core.crypto.BODY_CHUNK_SIZE
import com.garlictransfer.core.crypto.CommandHeader
import com.garlictransfer.core.crypto.RecordLayer
import com.garlictransfer.core.crypto.SessionKeys
import com.garlictransfer.core.oracle.LocalPskDeriver
import com.garlictransfer.core.util.recvExact
import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

object TestPorts {
    private val next = AtomicInteger(39200)
    fun take(): Int {
        val port = next.getAndIncrement()
        check(port <= 39900) { "test port range exhausted" }
        return port
    }
}

class Events : TransferListener {
    private val all = CopyOnWriteArrayList<TransferEvent>()
    override fun onEvent(event: TransferEvent) {
        all += event
    }

    fun snapshot(): List<TransferEvent> = all.toList()
    fun logs(): List<String> = all.filterIsInstance<TransferEvent.Log>().map { it.message }

    fun waitFor(timeoutMs: Long = 5000, predicate: (TransferEvent) -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (all.any(predicate)) return true
            Thread.sleep(10)
        }
        return all.any(predicate)
    }

    fun waitForLog(substring: String, timeoutMs: Long = 5000): Boolean =
        waitFor(timeoutMs) { it is TransferEvent.Log && it.message.contains(substring) }
}

/** Sends [payload] to 127.0.0.1:[port] over UDP until a reply arrives; returns it decoded. */
fun udpExchange(port: Int, payload: String, timeoutMs: Long = 5000): String {
    val client = DatagramSocket()
    client.soTimeout = 200
    try {
        val send = payload.toByteArray(Charsets.US_ASCII)
        val loopback = InetAddress.getByName("127.0.0.1")
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            client.send(DatagramPacket(send, send.size, loopback, port))
            try {
                val buffer = ByteArray(4096)
                val packet = DatagramPacket(buffer, buffer.size)
                client.receive(packet)
                return String(packet.data, packet.offset, packet.length, Charsets.US_ASCII)
            } catch (e: SocketTimeoutException) {
            }
        }
        throw AssertionError("no UDP response within $timeoutMs ms")
    } finally {
        client.close()
    }
}

/**
 * Scripted console-side client for one Data Transfer channel: 64-byte AE handshake
 * (client speaks first, as the PoC client does), local PSK key derivation, the empty
 * seq-0 completion record, then command headers with record-chunked bodies.
 */
class FakeConsole(host: String, port: Int, private val version: Int = 0x130) : AutoCloseable {
    val socket = Socket()
    lateinit var keys: SessionKeys
        private set
    lateinit var records: RecordLayer
        private set
    private var sendSequence = 0L
    private var recvSequence = 0L

    init {
        socket.connect(InetSocketAddress(host, port), 5000)
        socket.soTimeout = 10_000
    }

    fun handshake(completion: ByteArray = ByteArray(0)) {
        val clientValue = ByteArray(16) { (0x30 + it).toByte() }
        val output = socket.getOutputStream()
        output.write(clientValue + ByteArray(48))
        output.flush()
        val serverValue = recvExact(socket.getInputStream(), 64).copyOf(16)
        keys = LocalPskDeriver().derive(clientValue, serverValue)
        records = RecordLayer(socket.getInputStream(), output)
        records.send(keys.sendKey, keys.sendNoncePrefix, 0, completion)
        sendSequence = 1
        recvSequence = 0
    }

    fun request(cmd: Int, body: ByteArray = ByteArray(0), sub: Int = 2) {
        records.send(keys.sendKey, keys.sendNoncePrefix, sendSequence++, CommandHeader(cmd, sub, version, 0, body.size.toLong()).pack())
        var offset = 0
        while (offset < body.size) {
            val end = minOf(offset + BODY_CHUNK_SIZE, body.size)
            records.send(keys.sendKey, keys.sendNoncePrefix, sendSequence++, body.copyOfRange(offset, end))
            offset = end
        }
    }

    fun sendRecord(plaintext: ByteArray) {
        records.send(keys.sendKey, keys.sendNoncePrefix, sendSequence++, plaintext)
    }

    fun readRecord(): ByteArray = records.recv(keys.recvKey, keys.recvNoncePrefix, recvSequence++)

    /** Reads one command response: the header record plus enough records to fill its declared size. */
    fun readResponse(): Pair<CommandHeader, ByteArray> {
        val header = CommandHeader.parse(readRecord())
        val out = ByteArrayOutputStream()
        var remaining = header.bodySize
        while (remaining > 0) {
            val chunk = readRecord()
            out.write(chunk)
            remaining -= chunk.size
        }
        return header to out.toByteArray()
    }

    override fun close() {
        runCatching { socket.close() }
    }
}

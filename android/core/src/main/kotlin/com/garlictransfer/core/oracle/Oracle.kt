package com.garlictransfer.core.oracle

import com.garlictransfer.core.DtException
import com.garlictransfer.core.crypto.SessionKeys
import com.garlictransfer.core.crypto.deriveKeys
import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.recvExact
import com.garlictransfer.core.util.toHex
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.UUID

/** Derives session keys from the 16-byte client/server handshake values. */
fun interface KeyDeriver {
    fun derive(clientValue: ByteArray, serverValue: ByteArray): SessionKeys
}

/** Local PSK KDF for IPv6 channels and loopback emulation; no oracle needed. */
class LocalPskDeriver : KeyDeriver {
    override fun derive(clientValue: ByteArray, serverValue: ByteArray): SessionKeys = deriveKeys(clientValue, serverValue)
}

/** Kernel PPR oracle on a jailbroken console: 32 bytes in, 40 bytes out over TCP. */
class OracleDeriver(
    val host: String,
    val port: Int = 9022,
    val connectTimeoutMs: Int = 5000,
    val readTimeoutMs: Int = 30000,
) : KeyDeriver {
    override fun derive(clientValue: ByteArray, serverValue: ByteArray): SessionKeys {
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
            socket.soTimeout = readTimeoutMs
            val output = socket.getOutputStream()
            output.write(clientValue + serverValue)
            output.flush()
            val response = recvExact(socket.getInputStream(), 40)
            return SessionKeys(
                response.copyOfRange(0, 16),
                response.copyOfRange(16, 32),
                response.copyOfRange(32, 36),
                response.copyOfRange(36, 40),
            )
        } finally {
            runCatching { socket.close() }
        }
    }
}

/** Minimal synchronous HTTP surface so the HTOS client is testable and platform-neutral. */
interface HttpTransport {
    /** POST multipart form fields; returns the response body. Throws on HTTP errors. */
    fun postMultipart(url: String, headers: Map<String, String>, fields: Map<String, String>): String

    /** GET; returns the response body. Throws on HTTP errors. */
    fun get(url: String, headers: Map<String, String>): String
}

/** HttpURLConnection-based transport (works on the JVM and on Android). */
class HttpUrlConnectionTransport(val timeoutMs: Int = 30000) : HttpTransport {
    override fun postMultipart(url: String, headers: Map<String, String>, fields: Map<String, String>): String {
        val boundary = "----GarlicTransferBoundary" + UUID.randomUUID().toString().replace("-", "")
        val body = buildString {
            for ((name, value) in fields) {
                append("--").append(boundary).append("\r\n")
                append("Content-Disposition: form-data; name=\"").append(name).append("\"\r\n\r\n")
                append(value).append("\r\n")
            }
            append("--").append(boundary).append("--\r\n")
        }.toByteArray(Charsets.UTF_8)
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.requestMethod = "POST"
            connection.doOutput = true
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            connection.outputStream.use { it.write(body) }
            return readResponse(connection, "POST", url)
        } finally {
            connection.disconnect()
        }
    }

    override fun get(url: String, headers: Map<String, String>): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.requestMethod = "GET"
            for ((name, value) in headers) connection.setRequestProperty(name, value)
            return readResponse(connection, "GET", url)
        } finally {
            connection.disconnect()
        }
    }

    private fun readResponse(connection: HttpURLConnection, method: String, url: String): String {
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
        if (code !in 200..299) throw DtException("HTOS $method $url failed with HTTP $code: ${text.take(200)}")
        return text
    }
}

/**
 * HTOS volunteer worker oracle. Submits one ppr_derive job per derivation:
 * POST {serverUrl}/api/v1/jobs (X-Worker-Key header, fields operation/client_value/server_value),
 * polls GET /api/v1/jobs/{id} until done/failed, then GET /api/v1/jobs/{id}/result
 * which returns JSON {key1, key2, nonce1, nonce2} (hex).
 */
class HtosDeriver(
    val serverUrl: String,
    val workerKey: String,
    val transport: HttpTransport = HttpUrlConnectionTransport(),
    val pollIntervalMs: Long = 1000,
    val deadlineMs: Long = 120000,
) : KeyDeriver {
    override fun derive(clientValue: ByteArray, serverValue: ByteArray): SessionKeys {
        require(clientValue.size == 16 && serverValue.size == 16) { "client/server values are 16 bytes" }
        val base = serverUrl.trimEnd('/')
        val headers = mapOf("X-Worker-Key" to workerKey)
        val submit = parseObject(
            transport.postMultipart(
                "$base/api/v1/jobs",
                headers,
                linkedMapOf(
                    "operation" to "ppr_derive",
                    "client_value" to clientValue.toHex(),
                    "server_value" to serverValue.toHex(),
                ),
            ),
        )
        raiseOnError(submit)
        val jobId = submit["job_id"]?.jsonPrimitive?.contentOrNull
            ?: throw DtException("HTOS did not return a job ID")

        var completed = false
        val deadline = System.currentTimeMillis() + deadlineMs
        while (System.currentTimeMillis() < deadline) {
            val job = parseObject(transport.get("$base/api/v1/jobs/$jobId", headers))
            raiseOnError(job)
            when (job["status"]?.jsonPrimitive?.contentOrNull) {
                "done" -> {
                    completed = true
                    break
                }
                "failed" -> {
                    val logs = (job["logs"] as? JsonArray)
                        ?.mapNotNull { (it as? JsonObject)?.get("msg")?.jsonPrimitive?.contentOrNull }
                        ?: emptyList()
                    val detail = logs.joinToString("; ").ifEmpty {
                        job["error"]?.jsonPrimitive?.contentOrNull ?: "the volunteer worker failed"
                    }
                    throw DtException("HTOS derivation failed: $detail")
                }
            }
            Thread.sleep(pollIntervalMs)
        }
        if (!completed) throw DtException("HTOS derivation job $jobId did not finish within $deadlineMs ms")

        val result = parseObject(transport.get("$base/api/v1/jobs/$jobId/result", headers))
        raiseOnError(result)
        return SessionKeys(
            hexField(result, "key1", 32),
            hexField(result, "key2", 32),
            hexField(result, "nonce1", 8),
            hexField(result, "nonce2", 8),
        )
    }

    private fun parseObject(body: String): JsonObject {
        val element = try {
            Json.parseToJsonElement(body)
        } catch (failure: Exception) {
            throw DtException("HTOS returned a non-JSON response: ${body.take(200)}", failure)
        }
        return element as? JsonObject
            ?: throw DtException("HTOS returned a non-object response: ${body.take(200)}")
    }

    private fun raiseOnError(obj: JsonObject) {
        val error = obj["error"]?.jsonPrimitive?.contentOrNull
        if (!error.isNullOrEmpty()) throw DtException("HTOS error: $error")
    }

    private fun hexField(obj: JsonObject, name: String, length: Int): ByteArray {
        val value = obj[name]?.jsonPrimitive?.contentOrNull
            ?: throw DtException("worker result is missing $name")
        if (value.length != length || !value.matches(hexFieldPattern)) {
            throw DtException("worker returned an invalid $name")
        }
        return value.hexToBytes()
    }

    private companion object {
        val hexFieldPattern = Regex("[0-9a-fA-F]+")
    }
}

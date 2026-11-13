package com.garlictransfer.core.crypto

import com.garlictransfer.core.util.hexToBytes
import com.garlictransfer.core.util.toHex
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.junit.jupiter.api.assertThrows
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

class CryptoTest {

    private val cmacKey = "2b7e151628aed2a6abf7158809cf4f3c".hexToBytes()

    @Test
    fun `cmac aes rfc4493 vectors`() {
        assertEquals("bb1d6929e95937287fa37d129b756746", cmacAes(cmacKey, ByteArray(0)).toHex())
        assertEquals(
            "070a16b46b4d4144f79bdd9dd04a287c",
            cmacAes(cmacKey, "6bc1bee22e409f96e93d7e117393172a".hexToBytes()).toHex(),
        )
        assertEquals(
            "dfa66747de9ae63030ca32611497c827",
            cmacAes(cmacKey, "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411".hexToBytes()).toHex(),
        )
        assertEquals(
            "51f0bebf7e3b9d92fc49741779363cfe",
            cmacAes(
                cmacKey,
                (
                    "6bc1bee22e409f96e93d7e117393172a" +
                        "ae2d8a571e03ac9c9eb76fac45af8e51" +
                        "30c81c46a35ce411e5fbc1191a0a52ef" +
                        "f69f2445df4f9b17ad2b417be66c3710"
                    ).hexToBytes(),
            ).toHex(),
        )
    }

    @Test
    fun `pad unpad roundtrip`() {
        for (length in 0..64) {
            val data = ByteArray(length) { (it * 31 + 7).toByte() }
            val padded = pad(data)
            assertEquals((length / 16 + 1) * 16, padded.size)
            assertArrayEquals(data, unpad(padded))
        }
    }

    @Test
    fun `unpad rejects invalid padding`() {
        assertThrows<IllegalArgumentException> { unpad(ByteArray(0)) }
        assertThrows<IllegalArgumentException> { unpad(byteArrayOf(1, 2, 3, 0)) }
        assertThrows<IllegalArgumentException> { unpad(byteArrayOf(1, 2, 3, 17)) }
        assertThrows<IllegalArgumentException> { unpad(byteArrayOf(5)) }
    }

    @Test
    fun `command header pack parse roundtrip`() {
        val header = CommandHeader(cmd = 0xB2, sub = 7, version = 0x130, result = 0x23, bodySize = 0x1122334455667788)
        val packed = header.pack()
        assertEquals(CommandHeader.SIZE, packed.size)
        assertEquals(0xB2.toByte(), packed[0])
        assertEquals(7.toByte(), packed[1])
        assertEquals(0x30.toByte(), packed[2])
        assertEquals(0x01.toByte(), packed[3])
        assertEquals(0x23.toByte(), packed[4])
        assertEquals(0x88.toByte(), packed[8])
        assertEquals(0x11.toByte(), packed[15])
        assertEquals(header, CommandHeader.parse(packed))

        val helper = CommandHeader.parse(commandHeader(0x92, 5))
        assertEquals(0x92, helper.cmd)
        assertEquals(2, helper.sub)
        assertEquals(0x130, helper.version)
        assertEquals(0L, helper.result)
        assertEquals(5L, helper.bodySize)
    }

    @Test
    @Timeout(30)
    fun `record layer roundtrip over a socket pair`() {
        val clientKeys = SessionKeys(
            "000102030405060708090a0b0c0d0e0f".hexToBytes(),
            "101112131415161718191a1b1c1d1e1f".hexToBytes(),
            "20212223".hexToBytes(),
            "30313233".hexToBytes(),
        )
        val serverKeys = clientKeys.swapped()
        val (clientSocket, serverSocket) = socketPair()
        clientSocket.use { clientSide ->
            serverSocket.use { serverSide ->
                val client = RecordLayer(clientSide.getInputStream(), clientSide.getOutputStream())
                val server = RecordLayer(serverSide.getInputStream(), serverSide.getOutputStream())
                for (sequence in 0L..2L) {
                    val message = "record-$sequence".toByteArray()
                    client.send(clientKeys.sendKey, clientKeys.sendNoncePrefix, sequence, message)
                    assertArrayEquals(message, server.recv(serverKeys.recvKey, serverKeys.recvNoncePrefix, sequence))
                    val reply = "reply-$sequence".toByteArray()
                    server.send(serverKeys.sendKey, serverKeys.sendNoncePrefix, sequence, reply)
                    assertArrayEquals(reply, client.recv(clientKeys.recvKey, clientKeys.recvNoncePrefix, sequence))
                }
            }
        }
    }

    @Test
    @Timeout(30)
    fun `record layer rejects a sequence mismatch`() {
        val key = "000102030405060708090a0b0c0d0e0f".hexToBytes()
        val nonce = "20212223".hexToBytes()
        val (clientSocket, serverSocket) = socketPair()
        clientSocket.use { clientSide ->
            serverSocket.use { serverSide ->
                val client = RecordLayer(clientSide.getInputStream(), clientSide.getOutputStream())
                val server = RecordLayer(serverSide.getInputStream(), serverSide.getOutputStream())
                client.send(key, nonce, 5, "out-of-order".toByteArray())
                assertThrows<IllegalArgumentException> { server.recv(key, nonce, 0) }
            }
        }
    }

    @Test
    fun `deriveKeys is deterministic`() {
        val clientValue = "00112233445566778899aabbccddeeff".hexToBytes()
        val serverValue = "ffeeddccbbaa99887766554433221100".hexToBytes()
        val first = deriveKeys(clientValue, serverValue)
        assertEquals(first, deriveKeys(clientValue, serverValue))
        val other = deriveKeys(serverValue, clientValue)
        assertNotEquals(first.sendKey.toHex(), other.sendKey.toHex())
    }

    @Test
    @Timeout(30)
    fun `swapped session keys carry traffic both ways`() {
        val clientKeys = deriveKeys(
            "00112233445566778899aabbccddeeff".hexToBytes(),
            "ffeeddccbbaa99887766554433221100".hexToBytes(),
        )
        val serverKeys = clientKeys.swapped()
        assertArrayEquals(clientKeys.recvKey, serverKeys.sendKey)
        assertArrayEquals(clientKeys.sendKey, serverKeys.recvKey)
        assertArrayEquals(clientKeys.recvNoncePrefix, serverKeys.sendNoncePrefix)
        assertArrayEquals(clientKeys.sendNoncePrefix, serverKeys.recvNoncePrefix)
        val (clientSocket, serverSocket) = socketPair()
        clientSocket.use { clientSide ->
            serverSocket.use { serverSide ->
                val client = RecordLayer(clientSide.getInputStream(), clientSide.getOutputStream())
                val server = RecordLayer(serverSide.getInputStream(), serverSide.getOutputStream())
                val ping = "ping".toByteArray()
                client.send(clientKeys.sendKey, clientKeys.sendNoncePrefix, 0, ping)
                assertArrayEquals(ping, server.recv(serverKeys.recvKey, serverKeys.recvNoncePrefix, 0))
                val empty = ByteArray(0)
                server.send(serverKeys.sendKey, serverKeys.sendNoncePrefix, 0, empty)
                assertArrayEquals(empty, client.recv(clientKeys.recvKey, clientKeys.recvNoncePrefix, 0))
                val bulk = ByteArray(1000) { (it % 251).toByte() }
                client.send(clientKeys.sendKey, clientKeys.sendNoncePrefix, 1, bulk)
                assertArrayEquals(bulk, server.recv(serverKeys.recvKey, serverKeys.recvNoncePrefix, 1))
            }
        }
    }

    private fun socketPair(): Pair<Socket, Socket> {
        val server = bindTcp()
        val client = Socket()
        client.connect(server.localSocketAddress, 5000)
        val accepted = server.accept()
        server.close()
        return client to accepted
    }

    private fun bindTcp(): ServerSocket {
        var lastFailure: Exception? = null
        for (port in 39100..39900) {
            try {
                val server = ServerSocket()
                server.soTimeout = 15000
                server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
                return server
            } catch (failure: Exception) {
                lastFailure = failure
            }
        }
        throw IllegalStateException("no loopback TCP port available", lastFailure)
    }
}

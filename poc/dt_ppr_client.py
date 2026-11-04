#!/usr/bin/env python3
import argparse
import os
import socket
import struct

from poc.dt_psk_client import command_header, recv_exact, recv_record, send_record


def derive_with_oracle(host, port, client_value, server_value):
    with socket.create_connection((host, port), timeout=5) as sock:
        # Volunteer workers can take longer than the TCP connect timeout.
        sock.settimeout(30)
        sock.sendall(client_value + server_value)
        response = recv_exact(sock, 40)
    return response[:16], response[16:32], response[32:36], response[36:40]


def main():
    parser = argparse.ArgumentParser(description="PS5 Data Transfer PPR/ncdt client")
    parser.add_argument("host", nargs="?", default="192.168.0.125")
    parser.add_argument("--port", type=int, default=1004)
    parser.add_argument("--oracle-host", default="192.168.0.125")
    parser.add_argument("--oracle-port", type=int, default=9022)
    parser.add_argument("--message", default="HELLO-DT-PPR")
    args = parser.parse_args()

    with socket.create_connection((args.host, args.port), timeout=10) as sock:
        print("[*] connected; performing 64-byte AE handshake")
        client_value = os.urandom(16)
        sock.sendall(client_value + bytes(48))
        server_value = recv_exact(sock, 64)[:16]
        send_key, recv_key, send_nonce, recv_nonce = derive_with_oracle(
            args.oracle_host, args.oracle_port, client_value, server_value
        )

        print("[*] sending encrypted completion record")
        send_record(sock, send_key, send_nonce, 0, b"")

        body = args.message.encode()
        print("[*] sending Echo header and body in separate records")
        send_record(sock, send_key, send_nonce, 1, command_header(0x92, len(body)))
        send_record(sock, send_key, send_nonce, 2, body)

        print("[*] waiting for Echo response")
        response = recv_record(sock, recv_key, recv_nonce, 0)
        print("[+] response header:", response.hex())
        if len(response) != 16:
            raise ValueError(f"unexpected response length: {len(response)}")
        cmd, sub, version, flags, size = struct.unpack("<BBHIQ", response)
        print(f"[+] cmd={cmd:#x} sub={sub:#x} version={version:#x} flags={flags:#x} size={size}")
        if size:
            response_body = recv_record(sock, recv_key, recv_nonce, 1)
            print("[+] response body:", response_body)


if __name__ == "__main__":
    main()

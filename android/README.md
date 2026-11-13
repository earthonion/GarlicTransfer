# GarlicTransfer for Android (Kotlin port)

A native Android port of GarlicTransfer: upload and download PS5 saves to a latest-firmware
console, without a jailbreak, from your phone.

The port is split into two Gradle modules:

- **`:core`** — a pure Kotlin/JVM implementation of the Data Transfer protocol stack, ported
  from the Python PoC in `../poc/`. Runs on any JVM and on Android (blocking IO; the app wraps
  it in coroutines). Covered by JVM unit/integration tests that emulate both ends of the
  protocol on loopback.
- **`:app`** — the Android application (Jetpack Compose, Material 3, dark theme).

## What is ported

- Console discovery over DDP (`SRCH`/`LAUNCH4`, UDP 1006), including directed-IP probes.
- The encrypted channel (64-byte AE handshake, AES-128-GCM record layer, command framing).
- Key derivation: local PSK KDF (IPv6 / emulation), the on-console kernel oracle client
  (TCP 9022), and the HTOS volunteer-worker oracle over HTTPS.
- Download flow: 0x91 power request (with the captured body layout, account-hash prefixes,
  hardware/product patching), 0xA0 prepare, 0xB2 metadata/entry transfer, GFP5 receive,
  per-entry + root manifests, `DisconnectPS5` (0x94).
- Metadata engine: SQLite schema safety rules, filtered/single-user metadata generation,
  external-save synthesis, send-time size re-sync (ported from `dt_metadata.py`).
- Upload path: the full source-console emulator (`dt_source.py`) — discovery responder,
  command channel (0x91 power flow, 0x92 echo, 0xA1, 0x93, 0x94, 0xB0-B3), data channel
  (0xA0 busy dance, 0xB2 metadata + save chunks, 0xB4/0xB5 registry reads).
- One-time pairing listener (`dt_pair.py`): captures the console's 0x91 approval prefix.
- Local save library: inventory, export, atomic import with manifest regeneration.

Not ported: the read-only FTP front-end (`dt_ftp_server.py`) and the on-console oracle
payload deployer (the ELF binary in `poc/ncdt_oracle/` is used as-is by the desktop app;
on Android you point at an already-running oracle).

## Requirements

- JDK 17 or newer.
- Android SDK with platform `android-34` and build-tools 34 (set `sdk.dir` in
  `local.properties` or `ANDROID_HOME`).
- A PS5 and the phone on the same local network.
- A PPR oracle: HTOS volunteer worker key, or a jailbroken console running the oracle.
- **For Upload: root access on most devices** (see below).

## Build and test

```bash
cd android
./gradlew :core:test                       # JVM protocol tests (loopback emulation)
./gradlew :app:assembleDebug               # app-debug.apk
./gradlew :app:connectedDebugAndroidTest   # on-device loopback transfer test (needs a device/emulator)
```

Install and run on a connected device or emulator:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Upload and root (low port bindings)

Upload turns the phone into the transfer *source*: the console connects back to
**TCP 1004** and **TCP 1005**, and discovery listens on **UDP 1006**. These ports are below
1024, and Android's default `net.ipv4.ip_unprivileged_port_start` is 1024, so a normal app
cannot bind them.

When you start an upload, GarlicTransfer tells you this up front and offers three choices:

- **Continue with root** — via libsu, the app runs
  `sysctl -w net.ipv4.ip_unprivileged_port_start=1004`, which opens exactly ports
  1004-1023 for unprivileged binding (and nothing below). The default is restored when the
  transfer stops. Works with Magisk/KernelSU; if root is denied, the transfer aborts.
- **Try without root** — some kernels (and some emulators) allow low ports directly; if the
  bind fails, the app reports it.
- **Cancel.**

The upload screen also shows a persistent banner whenever the device blocks low ports, so
the requirement is visible before you select anything. The Upload engine runs in a
foreground service while hosting a transfer.

## Layout

```text
android/
  core/    protocol library (no Android dependencies)
  app/     Compose application
```

App storage: `files/profiles/<console-host-id>/{metadata.db, manifest.json, <entryId>/…}`,
mirroring the desktop `dt_downloads` layout, so profiles can be copied between devices.

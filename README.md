# GarlicTransfer

**Alpha release — 0.1.0**

GarlicTransfer is an Electron application for downloading PS5 save containers to a PC and uploading selected saves back to a console through Sony's Data Transfer protocol. It supports local PPR oracles on a jailbroken PS5 and volunteer workers through HTOS.

This is research software. Back up your saves before using Upload. Upload can overwrite or remove console save data, and the workflow intentionally asks you to delete the original saves first.

## Features

- Console discovery over DDP (`SRCH`) with firmware display.
- Per-console profiles keyed by host ID; each profile has separate metadata, manifests, and saves.
- Offline PS4/PS5 title names from [PlayStation-Titles](https://github.com/andshrew/PlayStation-Titles).
- A persistent console-to-PC session: browse once, then download one or more saves without re-entering Data Transfer mode.
- Single-user, multi-save upload selection using previously downloaded metadata.
- Filtered upload metadata and save-only transfer behavior based on a captured working transfer.
- Automatic source power signal and optional clean `DisconnectPS5` reboot after downloading.
- Local or volunteer PPR oracle support.

Console-to-PC downloading has been exercised on 13.60. On one tested 14.22 console, browsing from the home screen and downloading the save list has also been verified. Its power request used a hash of the PSN account ID. For the first browse, the app can capture that identifier through a one-time Data Transfer menu selection, read the account ID from a standard PS4 USB backup folder, or accept the decimal account ID. Other firmware versions use the inferred major-version mapping and remain unverified.

The confirmed 14.22 home-screen browse used the decimal account ID. The one-time pairing listener has automated protocol tests but has not yet completed a live PS5 pairing.

## Requirements

- Node.js 18 or newer and npm.
- Python 3.10 or newer.
- The Python packages in `requirements.txt`.
- A PS5 and PC on the same local network.
- An HTOS worker/API key for the volunteer oracle, or a jailbroken PS5 for a local oracle.
- On Linux, `pkexec`/PolicyKit for Upload and optional one-time pairing to bind Data Transfer ports 1004–1006. Only the Python helper requests elevation; Electron runs as the normal user. The pairing helper drops back to the app user before saving the identifier. On Debian/Ubuntu, the package is `policykit-1`.

## Install

```bash
git clone https://git.etawen.dev/earthonion/GarlicTransfer.git
cd GarlicTransfer
npm install
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Activate the Python environment before starting the app so its `python3` can import `cryptography`:

```bash
. .venv/bin/activate
npm start
```

On Linux, if `pkexec` is missing:

```bash
sudo apt install policykit-1
```

Do not run the whole Electron application as root. Upload and one-time pairing display a PolicyKit authentication prompt when privileged ports are required.

## Configuration

Open **Settings** in the app and choose **Save settings** to create `config.ini`. This file may contain your worker key and is deliberately excluded from git. `config.example.ini` documents the available settings.

Oracle choices:

- **Volunteer workers:** enter the HTOS server URL and a worker/API key from the server's Contribute page. The server must support `ppr_derive`; the corresponding worker implementation is in garlic-worker 1.1.7 or newer.
- **Local oracle:** disable volunteer workers and enter the jailbroken console's address. GarlicTransfer can deploy the included `poc/ncdt_oracle/ncdt_oracle_server.elf` through the console's payload listener on port 9021. The oracle listens on port 9022.

### Get a volunteer worker token

1. Create an account at [garlicsaves.com/register](https://garlicsaves.com/register), or sign in at [garlicsaves.com/login](https://garlicsaves.com/login).
2. Open [garlicsaves.com/contribute](https://garlicsaves.com/contribute).
3. Under **Generate Key**, enter a recognizable name such as `GarlicTransfer`, then click **Generate**.
4. Copy the new worker key immediately. HTOS shows it only once.
5. In GarlicTransfer, open **Settings**, keep **Use volunteer workers** enabled, paste the key into **Worker/API key**, and click **Save settings**.

This is an HTOS worker key, not a Forgejo token or a PSN credential. You do not need to run a worker console yourself to submit jobs to the volunteer oracle. The key is stored locally in `config.ini`, which is excluded from git.

The profile root defaults to `dt_downloads`. Downloads are separated as:

```text
dt_downloads/
  <console-host-id>/
    metadata.db
    manifest.json
    <save-entry-id>/
      manifest.json
      <save containers>
```

## Download saves

1. Start GarlicTransfer and click **Discover consoles**.
2. Select the source console. For the first browse on 14.22 on Windows or Linux, you can click **Pair this PS5 once**. When the listener is ready, open **Settings → System → System Software → Data Transfer** on the PS5 and select **GarlicTransfer Pairing** from the discovered consoles. The PS5 may say **Can't transfer data**; this pairing does not start a save migration. Return to the home screen after GarlicTransfer confirms pairing. The paired identifier is stored only in the app's private user-data folder and is reused for this console and firmware. Pairing is not yet available on macOS; use the account-ID or USB route there.
   Alternatively, click **Find in PS4 USB backup** and select the USB drive, its `PS4` or `SAVEDATA` folder, or the 16-hex-digit account folder inside `SAVEDATA`. You can enter the decimal PSN account ID instead. GarlicTransfer only reads folder names; it does not import or modify the PS4 save. After a successful browse, the per-console `metadata.db` supplies the ID automatically.
3. Click **Browse console saves** while the PS5 is at its home screen; you do not need to open Data Transfer on the PS5 first.
4. If asked, briefly press the console power button until it beeps and release.
5. Select one or more saves and click **Download selected**, or use the per-save Download button.
6. Keep the session open for more selections, or choose **Finish and reboot console**.

The account ID is used to construct the local Data Transfer approval request. It is not a password or PSN login. The app passes it to the Python backend over standard input, rather than placing it in the process command line. Enter it as a decimal string: JavaScript numbers cannot preserve every 64-bit account ID. If `PS4/SAVEDATA` contains several account folders, select the account folder for the same PSN user as the PS5 profile being browsed.

Downloaded entry folders contain the save containers and a manifest with paths, sizes, SHA-256 hashes, and GFP5 headers.

## Upload saves

1. Download metadata and the save containers first. Upload selections come from the selected console's existing metadata profile.
2. Click **Upload selected saves**.
3. Select one user and one or more downloaded saves.
4. Delete **all selected original saves** on the client console.
5. Confirm in GarlicTransfer and authenticate the backend if prompted.
6. On the console, open **Settings → System → System Software → Data Transfer**, press **Continue**, select **GarlicTransfer**, then **Start transfer**.

The source power signal is sent automatically after one second. Upload generates a filtered metadata database containing one user and only the selected save entries.

## Firmware mapping

The DDP `system-version` determines both the command protocol and power-body firmware value:

| Firmware | Command protocol |
| --- | --- |
| 1.02 | `0x010` |
| 13.60 | `0x130` |
| 14.22 | `0x140` |
| 15.00 | `0x150` |
| 21.00 | `0x210` |

Only 13.x/14.x are live-verified. The remaining mappings are inferred from the major-version pattern.

## Development checks

```bash
npm run check
python3 -m py_compile poc/dt_backend.py poc/dt_download.py poc/dt_metadata.py poc/dt_source.py poc/dt_discovery.py
node --test tests/account_id.test.cjs tests/pairing_store.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

## Title data

PS4 and PS5 title data is bundled from [andshrew/PlayStation-Titles](https://github.com/andshrew/PlayStation-Titles) under the MIT license. Its license and source notice are in `data/PlayStation-Titles-LICENSE.txt`.

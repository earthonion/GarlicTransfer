GarlicTransfer - Editor Popup and Right-Click Actions
Source: GitHub main 974ac25e2a650a13fe0725eea1dc91089f1d83b7 (v0.4.5)
The upstream app version values are preserved.
Our changes are rebased onto this upstream revision.

UPSTREAM SAVE LIST UPDATES
Local files has Search saves for game names, title IDs, filenames, users and
entry IDs in both tree and Classic layouts. Escape clears the search.
Local listing reuses size/mtime-validated file digests from
Transfer-Metadata/hash-cache.json. Uploads, imports and exports continue to
verify file content with fresh hashes. Our editor, batch PPSA, account, skin,
folder and local-worker additions are retained.

INSTALL
Close GarlicTransfer. Merge the update ZIP's resources folder into the resources
folder of a v0.4.5 installation, replacing app.asar,
poc/dt_save_editor.py, poc/dt_layout.py, poc/dt_local_saves.py,
poc/dt_metadata.py and poc/local_worker/garlic-local-worker.elf.
Stop the old local helper on the PS5
before deploying the updated payload. Run GarlicTransfer normally.

LOCAL WORKER NAME
The local payload calls sceKernelSetProcessName("GarlicWorker.elf") at startup.
Its packaged filename remains garlic-local-worker.elf for automatic deployment.
A naming failure is logged and does not prevent the helper from starting.

EDITOR LAYOUT
Decrypted files open in Hex. Select Text to edit UTF-8 when it can be converted
back to the exact same bytes. A UTF-8 BOM is preserved. Files with invalid UTF-8
or CR/CRLF line endings stay in Hex. Saving an untouched file skips the write,
and Save & encrypt can still encrypt it.
Large files open in the same editor. Use the mouse wheel to scroll or drag the
scrollbar to move through the whole file. Go to offset and Find use positions
in the edited file. Your edits stay in the draft as you scroll. Text mode checks
the whole file for a lossless UTF-8 conversion before switching. Select All
covers the loaded section. Use Export file to copy the whole file to disk.
Saving a large file streams the result to a temporary file alongside the
original. Keep enough free space for one copy of the edited file.
Text Find selects matches by their position in the original text, including
after Unicode characters. Moving through the file tree updates only the
previous and current rows.
Go to offset uses the current edited file length, including unsaved additions
or removals. Incomplete hex and empty drafts show a message without moving
the cursor. Escape closes the editor's More menu first; another Escape then
closes the editor after the usual unsaved-change check.
The current-account reader uses the named ACCOUNT_ID field in param.sfo.
A fresh folder scan is shared by the header, account reader and batch planner;
file changes are picked up on the next scan. Hex Find searches the edited
draft, advances to the next match and wraps around. Byte counts are coalesced
while typing and do not rebuild the byte array for each keystroke. Popup reset
and busy-control handling are shared. Batch failures report once with the
affected save name. Function notes use short labels such as Function = Read Account.

The information line shows Saves / Files / Current Account / Game ID / Game Name.
Use current ID, Target account and Add Account are underneath it. Add Account
is beside the target selector and appears only for a current ID that is not
already saved. The existing right-click Add Account action remains available.
Game names use the bundled title catalog, including for externally opened
workspaces, and stay present after file edits and replacements.

The decrypted file tree uses the full workspace width. Click a file to select
it; double-click, press Enter or choose Edit file from its right-click menu to
open the editor popup. Find, hex offsets, Replace file, Export file, Save changes
and Save & encrypt remain available. Closing a dirty editor asks before
discarding its draft. Switching Text/Hex keeps the draft and its dirty flag.
Save & encrypt closes the popup after saving, leaving job progress and Cancel
available in the main window.

Right-click a file, folder or empty tree area for Add Account or ReRegion.
Add Account uses the existing account naming and duplicate-name checks.
ReRegion shows the current PPSA and asks for its replacement. Apply commits
the target; Cancel keeps the previous choice. Leave it blank to clear the
pending title change. The chosen target is shown below the account controls
and is applied during encryption. Batch mode applies it to every save.
ReRegion is also in More and remains local-worker only.

LOCAL WORKER SHUTDOWN
Closing GarlicTransfer requests shutdown of each compatible local helper used
by this app session. Account-name saves and any approved close decision finish
first. The app cancels and drains its current save request before contacting
the helper. Canceling the close keeps the helper running.

The updated helper advertises its process-instance ID and a local shutdown
listener on TCP 9024. The app verifies that identity before requesting shutdown.
The helper stops new work, releases interrupted network waits, and finishes
save unmounting, credential restoration and temporary-file cleanup. It joins
its local threads and exits normally. The existing remote worker and an
independent oracle on 9022 are not stopped.

An older helper must be restarted with this updated payload once before
automatic shutdown is available. An unreachable console or replaced helper
is reported without sending a stop command to another process. Forced app
termination or loss of the network cannot guarantee remote shutdown.

PPSA TITLE CHANGES
In Local files, use the local worker and open a save. Choose ReRegion from
the right-click menu or More. Leave Replace with blank to keep the existing
title, or enter PPSA followed by five digits and Apply. Encrypt and Resign can apply the new title
while keeping the current Account ID or using the selected target account.
To resign with Use current ID, first decrypt that selected save so the app can
read its current Account ID.

The worker validates param.sfo and changes all complete matching source PPSA
references inside its used metadata values. This includes TITLE_ID, CONTENT_ID,
SAVEDATA_DIRECTORY and binary SFO metadata. It then rebuilds the encrypted
PS5PARAM metadata through the existing save engine, including CoW saves.
Malformed, conflicting or zeroed SFO data is rejected. Game payload files are
not searched or modified by the title change.

A changed title exports a new encrypted ZIP. It does not replace the original
save or its transfer metadata. Extract the new save into a folder named with
the target PPSA, then add that folder through the existing upload workflow.
The Upload button blocks sending the original entry while a different target
PPSA is selected. Decrypted workspaces retain their original metadata.

This option requires the updated local helper. Older helpers are detected
before a title-change job is sent. Hosted worker jobs keep their existing
behavior and do not receive this new parameter. Changing the PPSA does not
convert game-specific save formats; destination-game compatibility needs a
console test.

BATCH PPSA CHANGES
Open a decrypted workspace containing separate save folders, each with its own
sce_sys/param.sfo and chives.json. The editor shows the save count and an
Encrypt all button. Select one target PPSA to apply it to every save, or leave
the field blank to retain their original titles. Use current ID preserves
each save's own Account ID; choosing a target account applies it to all saves.

The local worker encrypts each save separately and the app collects their
results in one ZIP under PPSA#####/encrypted-filename. Extract that ZIP and
add the PPSA folder through the existing upload workflow. Batch export never
replaces the selected original save. Sources and chives.json are unchanged;
the existing worker updates each save's real SFO during encryption.

Each save needs its own valid metadata. Shared metadata, overlapping save
folders, missing account data and duplicate output names are rejected before
jobs start. The app builds the ZIP beside the chosen output and replaces it
only when complete. Canceling removes partial files. Batch export requires
local worker mode. Single-save workspaces and hosted worker jobs keep their
existing behavior.

CONSOLE TYPE
Locate currently reports PS5 for both standard and Pro systems when that is
the type returned by discovery. No automatic Pro model inference was added.

WINDOWS RESIGN DATABASE FIX
Resign metadata reads close their SQLite connections before returning or
retrying with a local copy. The resign tests also close their fixture and result
connections before temporary-folder cleanup. This fixes Windows metadata.db
file locks without suppressing cleanup errors. The resign files match the
reported CI commit 23c7d02746d1cf58959fea1411d8d49d215e6674 before this fix.

FIND PLAYSTATIONS
Locate PS5 lists each discovered console's name, type, IPv4, firmware,
Console ID and saved pairing status.
Choose JB for the local helper. This fills both JB helper PS5 IPv4 and Local
oracle IP; it does not change Use GarlicWorker or the transfer console.
Choose OFW for the transfer console: Source PS5 for PS5 to PC, Receiving PS5
for PC to PS5. Scanning alone does not assign a console or start a transfer.
On Windows, open Locate PS5 to check the PC adapter, network profile and local
IPv6 status using the buttons beside Source/Receiving PS5.
Enable IPv6 appears when IPv6 is off. Windows asks for administrator approval
before changing that adapter. The setting stays enabled when Garlic closes.
Allow local network access opens temporary transfer ports for this session
on Public and Private networks. Both actions work directly from Garlic.
Settings / Oracle / Maximum JB firmware defaults to 13.60. PS5s at or below
the limit can be selected as JB; higher or unknown firmware cannot. Set a
new limit, such as 14.22, and Save Settings when a newer firmware is supported.
Manual IPv4 discovery uses the same list. Existing selections are kept during
rescans, and console roles are locked while a transfer or save job is active.
Pairing shows Paired for this firmware, Pair again for pairing saved on another
firmware, Not paired when none is saved, or Unknown if it cannot be checked.
Pairing retains the 32-byte approval value from the console's Data Transfer
request, keyed by Console ID and firmware. Connections use the current IPv4;
the saved pairing is selected by identity rather than by its address.

FINDER CLEANUP
Console details are normalized before selecting roles or comparing identity.
Console ID capitalization and extra spaces in Type do not change selection.
If an IP reports another console, the list, sidebar and pairing panel require
an OFW selection again before starting a transfer. Existing files are retained.
Settings and the finder share the same maximum-JB-firmware validation.
Pairing statuses use a single lookup batch for each refresh and update their
cells directly. The pairing format and handshake are unchanged.
Paired indicators use the selected skin's success color.
Changing the discovered firmware clears cached live-transfer approval so the
next transfer starts a fresh session. A prepared upload uses the new firmware
and fresh-session flags while retaining its selected user, files and metadata.
Settings saves preserve newer firmware-limit edits made while saving, and late
results from older saves cannot replace the latest status or draft.

EDITOR FILE TREE
Edit your save now groups decrypted files into expandable folders.
Garlic keeps chives.json visible for export and protects it from editing,
replacement, addition, and deletion in every save folder. If existing metadata
is malformed, the tree shows which save needs attention. Restore a known-good
workspace or decrypt the original again before encrypting.
Right-click a file and choose Replace file to select a replacement on your PC.
The selected workspace file keeps its original name and folder location.
Cancel leaves it unchanged. Replacing the file currently open in the editor
asks before discarding unsaved text; edits to another open file are retained.
Use Save & encrypt or Export files to keep the updated save.

LOCAL PC SAVES
In Local files / My Saves, choose Local PC in the Console selector.
Click Browse folder and choose Saves/<USER>/PPSA##### or Saves/PPSA#####.
A parent containing Saves, a user folder or a single PPSA folder also works.
The selected folder and source are remembered. No transfer metadata is needed.
Saves without a user folder appear under Unassigned.
These folders must contain encrypted PS5 saves; arbitrary files are not saves.
Save & encrypt replaces the selected PC save after making a recovery backup.
Matching .bin sidecars stay associated with their save container.
Upload to PS5 stages all recognized encrypted files in the selected PPSA folder.
Choose the actual destination PS5 user in the upload dialog; a PC user-folder
name only groups files and does not set the account ID.
The editor More-menu fix and upstream save context-menu styles are included.

ZIP DROP DECRYPTION
Drop one encrypted save ZIP onto Decrypt another save to start decryption.
The same button still opens the file picker. The current Use GarlicWorker
setting selects remote or local processing, just like the picker workflow.
Existing workspace changes still require confirmation before replacement.
The original ZIP stays in place. Busy or closing apps do not queue a new job.

LOCAL SAVE PROCESSING
With Use GarlicWorker off, Decrypt/Encrypt/Resign use your local PS5.
Enter the local PS5 IPv4 address and start its ELF payload listener on 9021.
Local mode does not require a Server URL or server key.
With Use GarlicWorker on, the existing Server URL and key are used instead.
The bundled combined helper provides transfer keys on 9022 and local save
jobs on 9023. It is sent when needed; an existing compatible helper is reused.
Local inputs are packed and validated before helper startup. Each file and
its complete packed archive must fit below 4 GiB.
Results become available only after complete receipt and successful completion.
The saved-account updates do not change the helper binary or save-processing code.

SAVED ACCOUNTS
The current account appears beside the target selector in the save screens.
Known accounts show their saved name; hover over it to see the full hex ID.
Accounts without a saved name still show their hex ID.
Add Account beside Target account or in the right-click menu opens a Name dialog.
Enter a name and press Save or Enter.
Cancel or Escape closes it without adding an account.
Settings / Saved accounts has Account ID, Name and Remove columns in its own
scroll area. Type directly in the Name field; it saves after a short pause.
Enter or leaving the field saves immediately. There is no separate Edit button.
Saving keeps the same text box, focus, caret and any newer text being typed.
Failed name saves keep your draft and show the error beside that name.
Other accounts can still save. Press Enter or edit the failed name to retry.
Errors from an older request do not invalidate newer text. Corrected names
continue saving, and reverting to the saved name clears the obsolete error.
Names are limited to 64 characters. Add and Rename show "Name already in use."
for matching names, ignoring capitalization and surrounding spaces.
Blank names use the Account ID. Existing lists remain readable.
Failed additions keep the Name dialog open for correction and retry.
Confirmation prompts use a native app dialog to avoid the Windows input-focus
issue associated with browser confirm pop-ups. Cancel keeps the current data.
Choose Display name or Account ID for the target selector in Settings.
Use current ID starts checked and keeps the save's existing account when
encrypting. Uncheck it to choose a saved target, or leave Choose account
selected to enter a target ID manually in the save action.
The target applies to Encrypt, Save & encrypt and Resign in local and remote
modes. Save & encrypt applies the target during encryption; no separate resign
step is needed. These controls are also available before decrypting a save.
Removing the selected account restores Use current ID. Checking Use current ID
remembers your saved target for when you uncheck it again.
The list, names, display preference and target selection are saved automatically
in account-list.json in the application's user-data folder. Existing saved
accounts remain available after updating the app.
Closing or quitting waits for pending account-name saves. If saving fails,
choose Keep editing to correct it, or Discard unsaved names and close.
New transfers, discovery and imports wait while the final name saves finish.
Existing jobs can complete normally. Keeping the app open restores controls.
Close checks follow the current app page after a reload; old replies are ignored.
An unreadable account-list.json is preserved in an exclusive recovery backup
before a later change replaces it. Failed backups prevent replacement.
Recovery files are beside it, named account-list.json.recovery-<id>.bak.
Recovery retries recheck the source before replacement. If it was manually
changed or repaired, saving stops and asks you to restart GarlicTransfer.

LOCAL ADDITIONS CLEANUP
- Transfers and save editing share helper startup and connection checks.
- Cancel stops the app request and waits for cleanup before another save job.
- Remote deadlines cover uploads, status requests, polling and result downloads.
- A busy helper port waits for readiness without deploying another helper.
- Inactive Local PC folders avoid scans; user filters reuse loaded inventory.
- Refresh and file operations still validate current files and selected titles.
- Workspace details and account IDs share one folder walk without stale caching.
- Edited files use unique staging; failed writes preserve the original file.
- Add files checks conflicting names before copying and rolls back its new
  files if copying or the final workspace refresh fails.
- Failed Local PC exports and upload preparation clean up their owned files.
- Generated temporary files are released after their consumers finish; open
  workspaces remain available while editing, exporting or running save jobs.
- Original saves, recovery backups and user-selected folders are preserved.
- Existing temporary folders from earlier app sessions are not swept.
- Function notes remain short, such as Function Workspace Scan.

Cancel or timeout closes the app request. A PS5 or remote worker may finish
its current processing after the app disconnects.
Save changes updates the decrypted workspace; encrypt or export files to keep
those edits. Closing or replacing a generated workspace releases its temporary
files after confirmation, including confirmation for unencrypted saved edits.

EXTERNAL SKINS
Choose a skin in the left sidebar below USER - source saves.
The skin selector and small Open/Reload buttons are sidebar-only; the
Appearance card has been removed from Settings. Garlic Classic remains available.
Spicy Garlic, Chill Onion, Onion, Green Onion and Evil Onion are included.
Each now uses skin.json and mascot.png; all share one tree stylesheet.
The sidebar Open button opens %root%/Skins beside GarlicTransfer.exe.
External skins now load only from that folder. Copy any existing AppData
skin folders into it to keep using them; nothing is moved automatically.
Copy the provided skin-template/my-onion folder into that opened folder.
Edit its skin.json name/colors and replace mascot.png with your PNG.
Click Reload in the sidebar, then select My Onion. No rebuild is needed.
Skin files contain data and PNG only.
Missing colors use light/dark defaults. Bad files report a message while
other skins load. Missing artwork uses the Spicy Garlic mascot. Low-contrast
text palettes fall back to readable defaults. A removed selected skin shows
Garlic Classic without deleting the saved preference.

INCLUDED FOLDER CHANGES
Saves/<user-id>/<PPSA or CUSA>/<encrypted-save-files>
Transfer-Metadata/ (databases, manifests and transfer metadata)
Other Needed Data/ (support files, backups and staging)
Save folders contain payloads only; existing legacy layouts remain readable.
Multi-file Add save folder uploads and short function notes remain included.
The tree uses the existing Garlic download, upload, editor, import/export
and resign workflows. Source-user filters do not change upload destination.
CMP Fix All, complete-save staging and completion tracking are not added.

SKIN OPTIMIZATIONS
- Mascots load only for the selected skin, rather than every listed skin.
- Unchanged definitions and artwork reuse bounded caches.
- Edited, deleted and invalid files are rechecked with normal fallback behavior.
- Same-layout skin changes and Settings navigation do not rebuild save trees.
- Scroll, focus, expanded branches and selections stay in place for color changes.
- Warnings have a separate expandable list and stay visible after saving.
- Skin options sort by display name, with Garlic Classic first.
- Function notes use short identifiers such as Function Skin Loading.
- Existing skin format, %root%/Skins and NAME-TO-LONG remain supported.
- All previous skin, folder and upload changes are included.

TREE CLEANUP
- Files match exact normalized user, game title and entry ID; no cross-entry fallback.
- Shared tree adapters replace duplicate upload/local wiring and repeated searches.
- Upload checkbox changes update selection and labels without rebuilding trees.
- Unchanged tree data reuses existing DOM while callbacks use current records.
- Changed inventory restores expansion, scroll and matching focus when possible.
- Local/global busy state consistently controls filters and tree actions.
- Keyboard context menus open once; latest actions are used after refresh.
- Refreshing the same profile retains the selected save and current workspace.
- Older local inventory responses cannot replace newer results.
- Basic function notes remain, such as Function Tree Refresh.

INCLUDED TREE CLEANUP
- Collapsed branches stay remembered while user filters hide/show them.
- Branch memory is bounded and clears for a different console/profile.
- Hidden Classic save tables are skipped in tree mode and built from current
  data on return to Classic. Other-content tables remain available.
- Mascots that fail browser decoding fall back once to the bundled mascot.
- If the fallback also fails, the broken image hides with a sidebar warning.
- Escape and menu actions restore focus to the opening row when appropriate.
- Outside clicks, refresh and removed rows do not steal keyboard focus.
- Function notes remain basic, such as Function Menu Focus.
- All previous changes and external skin formats are included.

VALIDATION
577 Node tests and 145 Python tests passed locally. Native checks exercise the
PPSA parser, verified file writes and shutdown control, including waiting for a
failed unmount to succeed before restoring credentials or deleting files. The separate
native helper transport suite passed 14 tests. The PS5 payload cross-compiled
with the pinned toolchain. Windows CI and live PS5 execution still need testing.
The packaged Electron files match the tested source.
Name entry, automatic saving, Enter, Cancel/Escape, failed-save retry, focus,
caret retention and current-name tooltips are covered by DOM event tests.
Windows appearance and native input still need testing on your machine.
No live PS5 test performed.

CONTENTS
The update ZIP contains resources/app.asar and
resources/poc/local_worker/garlic-local-worker.elf, plus this README.
The source ZIP opens directly at the project root, with source and tests.
skin-template/my-onion/: editable external add-in example.
poc/local_worker/: matching helper source and GPL license.

MASCOT LOADING FIX (v0.3.3)
Mascots remain invisible until their image load event. The reserved image
space prevents name/alt-text flashes and layout jumps, including fallback
loading. Unchanged loaded mascots stay visible on reload.
The mascot code matches the full-resources build from before the size cleanup.

CI DEPENDENCIES
The identity-check workflow installs locked development dependencies before
testing. This includes jsdom for the skin and tree tests. Install scripts
are skipped in that test job because the Electron binary is not needed.

WINDOWS DATABASE CLEANUP
SQLite readers and test fixtures close their connections explicitly, including
query failures. This releases database files before temporary-folder cleanup.
POSIX privilege tests run only on POSIX; Windows pairing behavior has a separate
test. All languages, plain title lists and original artwork are retained.

#!/bin/sh
# Install the polkit policy so pkexec can elevate the upload backend
# without prompting for the action ID every time.
POLICY_SRC="/opt/GarlicTransfer/resources/build/linux/com.earthonion.garlictransfer.policy"
POLICY_DST="/usr/share/polkit-1/actions/com.earthonion.garlictransfer.policy"
if [ -f "$POLICY_SRC" ]; then
    cp "$POLICY_SRC" "$POLICY_DST"
fi

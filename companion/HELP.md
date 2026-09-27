# Apple TV

No Python or terminal setup is required. Keep Apple TV and Companion reachable
on the same local network.

1. Enable the connection and Save. Select your Apple TV from the list. Use
   **Refresh device list when saving** if it is missing.
2. Watch the TV, check **Start pairing when saving**, and Save.
3. Enter the TV's four-digit PIN and Save again within three minutes.
4. Wait for **Connected**. The PIN clears after submission; verified keys are
   saved in Companion's connection secrets for future restarts.

Pairing never starts automatically. If it fails or expires, explicitly start a
new attempt. Disabling the connection cancels a pending attempt. Upgrading from
the Python module requires new PIN pairing; existing button mappings remain.
Keep a backup and the previous package, Python environment and credential file
until you have accepted the replacement.

Remote command offers navigation, playback, volume, seeks, swipes, App Switcher,
Control Center, Screensaver and power. Launch App lists the TV's applications.
Available playback commands and Now Playing metadata depend on the active app.
Personal AirPods selection and text entry are not implemented.

Mute saves a nonzero level, then sets volume to zero. Press again to restore only
while the same output and valid feedback remain. Output changes, external volume
changes, capability loss and reconnect discard that saved level; switching back
to AirPods does not automatically restore it. **Unavailable** means the module
cannot safely restore a level. Numeric volume does not prove perceived loudness.

Wake uses Home when the TV reports Off and returns to the Home screen. An
immediate sleep/wake cycle is not qualified; allow the TV to finish sleeping.
Commands are not replayed after failure. `last_result` reports dispatch, not a
physical result. Connection loss clears stale metadata and reconnects using
saved keys without a new PIN prompt.

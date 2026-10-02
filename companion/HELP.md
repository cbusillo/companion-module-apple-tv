# Apple TV

No Python or terminal setup is required. Keep Apple TV and Companion reachable
on the same local network.

1. Enable the connection and Save. Select your Apple TV from the list. Use
   **Refresh device list when saving** if it is missing.
2. Watch the TV, check **Start pairing when saving**, and Save.
3. Enter the TV's four-digit PIN and Save while the prompt is still open.
4. Wait for **Connected**. The PIN clears after submission; verified keys are
   saved in Companion's connection secrets for future restarts.

Pairing never starts automatically. The module waits up to three minutes, but
the TV can close the session earlier; Companion reports when that happens.
If pairing fails or expires, explicitly start a
new attempt. Disabling the connection cancels a pending attempt. Upgrading from
the Python module requires new PIN pairing; existing button mappings remain.
Keep a backup and the previous package, Python environment and credential file
until you have accepted the replacement.

Remote command offers navigation, playback, volume, seeks, swipes, App Switcher,
Control Center, Screensaver and power. Launch App lists the TV's applications.
Available playback commands and Now Playing metadata depend on the active app.
Text entry is not implemented.

## Personal audio output (AirPods)

Set **Personal output name contains** (for example `AirPods`) to enable the
**Personal audio output** action. Select the AirPods once from the TV's Control
Center so the module sees them in the TV's output list; it then remembers their
identifier in the connection secrets. Leave the name empty to disable the feature.
**Personal output identifier** overrides the name match when needed.

The action's Route option is **Toggle personal output**, **Route to personal
output** or **Route to default output**. Toggle decides the direction from the
TV's current output list. Each press sends one request and is never retried.
Returning to default selects the other outputs the TV currently reports.

`personal_output_route` shows `Personal`, `Default`, `Connecting`, `Failed` or
`Unavailable`; `personal_output_name` shows the remembered output name. The
**Personal audio output active** feedback follows the reported route. The route
comes only from the TV's reported outputs, so changes made on the TV also update
it. `Failed` appears after 20 seconds without confirmation, or immediately if
the TV rejects the request. It clears after 10 seconds or as soon as the route
changes, so a late connection still shows the real route. `Unavailable` means
the feature is disabled, the TV is not connected, the AirPods have not yet been
seen, or this connection cannot change outputs.

Taking over AirPods that are connected to another Apple device on the same
account can take longer than 8 seconds; nearby idle AirPods usually confirm in
under a second. If a press fails while the AirPods are still switching, wait for
the route to update before pressing again.

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

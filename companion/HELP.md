# Apple TV

Disabled by default. Requires a separately prepared local Python environment and
owner-only credential JSON file. Read README.md before enabling a connection.

This module communicates directly with pyatv in its own child process. It does
not pair devices or claim physical outcome confirmation.
Supported commands depend on the connected device's reported capabilities.

Version 0.3 includes volume save/zero/restore, Control Center, App Switcher,
Screensaver, sleep/wake, and app launching. An optional separately provisioned
AirPlay credential adds Now Playing metadata. See README.md for the interactive
pairing helper and volume restore behavior.

Do not paste credentials into configuration fields or committed files.

## Pairing utility

Run from an interactive terminal with the exact host and stable identifier:

```sh
uv run python bridge/pair.py \
  --host DEVICE_HOST --identifier DEVICE_IDENTIFIER \
  --output ~/.config/companion-apple-tv/credentials.json
```

The parent directory must be private (0700). The utility prompts for the
four-digit TV PIN without echo, verifies a connection and read-only app-list
query, and publishes a complete 0600 credential file without replacing an
existing file. PIN and credentials are never command arguments or printed. A
failed pairing may leave an authorization on the TV; reconcile it in tvOS if
abandoning setup. If replacing revoked credentials, choose a new filename,
verify it, then select that file in Companion. Keep the old file until rollback
is no longer needed.

Idle health checks share the action queue. New input may briefly wait behind a
probe; input older than one second expires, and no command is retried. An
unsupported or failed health query prevents the module claiming readiness. The
app-list query's sleep/wake behavior must be confirmed on the actual device
before accepting this as a replacement.

## Companion permissions

The module declares `filesystem` to read its owner-only credential file and
`child-process` to run the Python worker. Companion currently grants general
filesystem access for that declaration; it cannot limit the grant to one file.
The module itself validates the selected file and directory and does not write
credentials. The separate pairing utility owns credential creation.

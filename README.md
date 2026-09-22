# Apple TV Companion module

Apple TV control for Bitfocus Companion using a persistent, locally spawned
Python worker backed by pyatv. The module provides remote commands, power and
playback control, application launching, swipe gestures, and optional Now
Playing metadata.

The Python runtime is currently an explicit installation prerequisite. New
connections start disabled, and pairing is handled by a separate interactive
utility rather than by the runtime worker.

## Development

Use Node 22 and Yarn 4 (`npx --yes --package=@yarnpkg/cli-dist@4.17.0 yarn` is
an alternative to installing Yarn globally).

```sh
yarn install
uv sync --locked
yarn build
yarn test
uv run python -m unittest discover -s tests -p 'test_*.py' -v
yarn lint
yarn package
```

## Setup

1. Load the module into Companion, leaving Enable Apple TV connection unchecked.
2. Run `uv sync --locked`, then set the Python executable to the absolute path
   of this project's `.venv/bin/python`. Dependencies are not downloaded when
   a Companion button is pressed.
3. Select an explicitly prepared credential JSON file with `host`, `identifier`,
   and `credentials`. The file must be regular, owner-owned, mode 0600, and
   outside any repository. Do not reuse credentials from another integration.
4. Confirm the exact physical target before enabling the connection. An
   existing pyatv storage file has a different schema and cannot be used
   directly. Run the separate interactive pairing utility described below; the
   runtime worker never pairs devices.

One Remote command action exposes navigation, select, back, home, play/pause,
previous/next, relative volume (one step), seek (ten or thirty seconds), and
fixed brisk up/down/left/right touchpad swipes.
The worker checks the current pyatv capability immediately before each action.
Cached availability never blocks a newly available action; unsupported commands
are rejected without replay. Version 0.3 adds Control Center, App Switcher,
Screensaver, state-based sleep/wake, app launching by bundle identifier, and
volume save/zero/restore. Text entry remains outside the module.

Volume save/restore requires current `Volume` and `SetVolume` availability. It
never guesses a level when playback is already at zero. The saved level is
session-local and cleared by dial changes, external nonzero volume changes,
reported output-device changes, lost capabilities, or reconnect. Output changes
that the device does not report cannot be detected. A power toggle refuses an
unknown state rather than guessing which command to send.

## Now Playing

An optional AirPlay pairing enables the MRP metadata transport. Add it to a new
credential file with the interactive helper; the existing remote pairing stays
untouched:

```sh
uv run python bridge/pair_metadata.py \
  --source ~/.config/companion-apple-tv/credentials.json \
  --output ~/.config/companion-apple-tv/credentials-with-metadata.json
```

Select the new file in Companion after successful verification. The helper
never accepts a PIN as a command argument, prints credentials, or overwrites an
existing destination. The runtime never initiates pairing.

The module polls cached device metadata once per second through its serialized
worker queue and provides title, artist, app, playback state, elapsed time,
remaining time, progress, volume, mute-save state, and power variables. Live
streams without a duration have no invented remaining time. Transient metadata
errors retain the last good text and mark it stale. Connection loss explicitly
marks telemetry offline. Available metadata depends on the playing app.

The connection variable reports session setup, not independently verified
playback or device power. `last_result` distinguishes dispatch acknowledgement
from physical state confirmation. Readiness requires a successful app-list round
trip. Disconnect notifications invalidate the session immediately; after 30
seconds idle another app-list query detects a silent connection loss within a
three-second request timeout.

Since 0.2.3, `last_result` replaces `unavailable or busy` with separate
`not connected; not sent`, `unknown command; not sent`, and `busy; not sent`
results. Unsupported actions report `unsupported by current playback`. Update
any custom comparisons against the old strings when upgrading.

## Failure and lifecycle contract

- At most eight submitted actions; queued input expires after one second.
- At most one worker request in flight. An action timeout terminates the
  session; the result is unknown, never retried.
- Session generation changes discard old queued input and late results.
- Connection retries back off from five to sixty seconds plus up to one second
  of jitter. They do not replay actions.
- Credentials travel over the private child pipe, never command arguments or
  module logs. Python diagnostics are suppressed; only bounded result categories
  are emitted.
- The worker has no network listener and does not persist credentials.

## Provenance

`bridge/controller.py` adapts an Apple TV protocol adapter from the MIT-licensed
Media Control Relay project. Its license is preserved in LICENSE-MCR. This is
source reuse, not a runtime dependency. The worker excludes discovery and
pairing operations from its public request surface. pyatv 0.18.0 is locked in
uv.lock. Bitfocus's official TypeScript module template is retained in Git
history.

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

# Apple TV Companion module

Control Apple TV from Bitfocus Companion, with discovery, PIN pairing, remote
buttons, app launching and Now Playing variables. Version 0.5 runs entirely in
Companion's Node runtime. Users do not install Python, run a terminal command or
prepare a credential file.

## Setup

1. Import the built package into Companion and add an Apple TV connection.
2. Enable the connection and Save. Select your Apple TV from the discovered list.
   If needed, check **Refresh device list when saving** and Save again.
3. While watching that TV, check **Start pairing when saving** and Save.
4. Enter the four-digit PIN shown on the TV and Save while the prompt is still open.
5. Wait for **Connected**. Keys are saved in Companion's connection secrets after
   a fresh connection verifies remote control and metadata access.

Apple TV and Companion must be reachable on the same local network with Bonjour
discovery available. A saved pairing uses the TV's discovered identifier, so a
changed IP address does not require editing the connection. A PIN appears only
after an explicit pairing request; reconnects never start pairing automatically.

The PIN clears after submission. The module waits up to three minutes, but the
TV can close its session earlier. Companion reports that closure immediately.
If pairing fails or expires, explicitly start a
new attempt. Previous saved keys are retained until a replacement verifies.
Disabling the connection cancels a pending attempt. Failed pairing can leave a
controller registration on the TV; remove only the abandoned registration from
tvOS when retiring it.

## Upgrading from the Python version

Keep a Companion backup and the previous package before upgrading. Existing
connections start disabled after migration and require one new PIN pairing.
Enable, discover, select and pair using the steps above. Existing Remote command
and Launch App action IDs and variable names are preserved, so buttons keep their
mappings. Old Python and credential-file paths remain in the saved config for
rollback; the Node runtime does not read them. Keep that environment and file
until the new installation has been accepted.

## Controls and feedback

Remote command provides navigation, Select, Back, Home, Control Center, App
Switcher, Screensaver, play/pause, previous/next, ten- or thirty-second seeks,
relative volume, mute save/restore, power toggle and four swipe directions.
Launch App lists applications reported by the TV and accepts existing bundle
identifiers. Playback commands depend on the active app's advertised capabilities.
Text entry is not implemented.

Power toggle requires a current known state. Wake sends Home only while the TV
reports Off, so it opens the Home screen rather than resuming the previous stream.
Wake from an already-asleep TV and a cycle with twenty seconds asleep passed on
the test device. An earlier five-second cycle failed; no minimum safe interval
has been established. Avoid immediate sleep/wake automation until it is qualified
on your device.

Mute saves a nonzero reported volume and sets it to zero. A second press restores
the saved value only while the audio output and feedback remain valid. A dial
change, external volume change, output change, lost capability or reconnect
discards the saved level. Switching back to AirPods does not automatically restore
audio. A missing or discarded level is **Unavailable**, not a guessed mute state.
Output changes are observable only when reported by the TV; numeric volume does
not prove perceived loudness or per-output accuracy.

Variables include connection, title, artist, app, playback state, elapsed and
remaining time, progress, volume, mute-save state, power, personal output route
and name, and `last_result`.
Elapsed time advances from the selected player's reported position, timestamp
and playback rate; it freezes on pause and clears on connection loss. Streams
without a duration have no invented remaining time. Metadata availability depends
on the playing app. `last_result` describes dispatch, rejection or uncertain
delivery, never physical confirmation. Its wording changed from the Python
version; update custom comparisons if used.

## Personal audio output

The **Personal audio output** action selects a personal output, such as
same-account AirPods, as the TV's system audio route. Enable it by setting
**Personal output name contains** (for example `AirPods`); an empty value
disables it. The TV must report the AirPods once, for example after selecting
them from its Control Center. The module then remembers their output UID in the
connection secrets, not the public configuration. If several reported outputs
match, nothing is learned. **Personal output identifier** overrides the match.

| Item                                               | ID                      | Values                                                       |
| -------------------------------------------------- | ----------------------- | ------------------------------------------------------------ |
| Action **Personal audio output**, option **Route** | `personalOutput`        | `target`: `toggle`, `personal` or `default`                  |
| Route variable                                     | `personal_output_route` | `Personal`, `Default`, `Connecting`, `Failed`, `Unavailable` |
| Name variable                                      | `personal_output_name`  | Remembered output name                                       |
| Boolean feedback **Personal audio output active**  | `personalOutputActive`  | True while the AirPods are in the reported route             |

The module sends one MRP `ModifyOutputContextRequest` with the `SharedSystemAudio`
context over the authenticated AirPlay session. Toggle chooses the direction
from the live output list. Returning to default selects the other outputs the
TV currently reports. Requests are never retried. The TV's acknowledgement is
not treated as success; only the reported output list confirms the route. A slow
or missing acknowledgement, common while AirPods are taken over from another
device, ends only that wait and never drops the connection.
`Connecting` lasts until confirmation or 20 seconds. `Failed` follows a timeout
or rejection and clears after 10 seconds or on the next route change. A late
connection or a change made on the TV therefore still updates the variable.
Reconnects cancel a pending request without replaying it.

Taking over AirPods connected to another Apple device on the same account can
take more than 8 seconds; idle nearby AirPods confirmed in 0.2-0.5 seconds on
the test TV. The older `SharedAudioPresentation` speaker-group request is not
used because it did not reliably select AirPods.

## Failure and lifecycle contract

- One serialized action queue, at most eight operations, with input expiring
  after 500 ms waiting. Complete button and swipe gestures stay together.
- Failed or lost sessions discard queued actions and stale feedback. Controls
  are never automatically retried, including after uncertain delivery.
- Remote and metadata connections reconnect together using saved pairing and
  bounded backoff. Read-only health checks detect silent failures.
- A command the TV does not answer in time is dropped, not retried, and the
  session stays up; three unanswered commands in a row, a failed health check
  or a closed connection end it. Each session loss and reconnect is written to
  the Companion log with its reason. A lost Companion connection names how it
  ended: a socket error with its code, or a close by the TV, with any frame the
  library could not read just before it.
- A frame the TV sends that the library cannot decode is dropped; it no longer
  ends the session.
- Disabling or destroying the connection cancels discovery, pairing, requests,
  sockets and timers. Keys remain in Companion's secret store.
- The package needs no child-process or general filesystem permission. It reads
  its own bundled protocol schemas. Companion's handling of secrets and backups
  still applies; do not publish backups containing pairing keys.

## Development and qualification

Use Node 22 and Yarn 4. Python is used only for the independent protocol oracle
and retained reference-worker tests, not by the packaged module.

The shared `Companion Apple TV` JetBrains inspection profile is selected by the
inspection gate. It leaves arrow-parameter parentheses to Prettier and disables
unused-global-symbol findings only under `tests/`, where duck-typed fakes expose
members indirectly. Other IDE state remains local and ignored.

```sh
yarn install --immutable
yarn build
yarn test
yarn lint
yarn package
yarn test:package
uv sync --locked
uv run python -m unittest discover -s tests -p 'test_*.py' -v
uv run --python 3.13 --locked python experiments/node-library/loopback-peer.py
uv run --python 3.13 --locked python experiments/node-library/loopback-peer.py --package pkg/apple-tv/main.js
uv run --python 3.13 --locked python experiments/node-library/mrp_fixtures.py | node experiments/node-library/metadata-oracle.mjs
```

CI checks the bundle on Linux, macOS and Windows. Synthetic tests cover setup,
secret persistence, restart, cancellation, migration, encryption, metadata,
queue expiry and reconnect without replay. The package test loads the real bundle
and schemas with filesystem access restricted to the package. The independent
pyatv peer also exercises real bundled PIN pairing, closure while awaiting a PIN
and rejection of an invalid identity signature. Hardware testing
so far covers one Apple TV; this does not establish compatibility with every tvOS
version, app, audio route or operating-system installation.

The [library patch and qualification notes](experiments/node-library/README.md)
describe the reproducible extensions to `node-appletv-remote` 0.3.2 and the separate
developer harness. Source and compiled patches are checked in together. No
upstream acceptance or distribution approval is implied by the candidate.

## Provenance

The project started with Bitfocus's TypeScript template and a Python adapter
reused from the MIT-licensed Media Control Relay project. Historical Python source
and `LICENSE-MCR` remain for reference and rollback work. The Node runtime uses
the patched MIT-licensed `node-appletv-remote` library; package generation includes
the bundled dependency license inventory. pyatv 0.18.0, locked in `uv.lock`, remains
the independent protocol reference.

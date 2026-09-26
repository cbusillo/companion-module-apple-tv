# Node library feasibility prototype

This is a feasibility prototype of extensions to `node-appletv-remote` 0.3.2,
with offline tests and a separate, explicit-target live test harness.
The normal Companion entry point still uses the existing Python worker.
The candidate library is a development dependency, and the prototype is not
loaded by the connection or included in the Companion bundle.

The prototype composes app listing/launching, explicit seek intervals, absolute
volume read/write, and power-state queries through the library's public
`sendCompanionRequest` API. It does not access private transport internals.
The live harness supplies an authenticated session through the library's public
connection API. It does not read the installed module's configuration or credentials.

## Findings

The public request API is sufficient for the command layer, but the published
codec and encrypted framing need changes before they can carry all the required
messages correctly:

| Case                                   | Published 0.3.2                                                               | Candidate                     |
| -------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| Backward seek value `-10`              | Encodes a signed integer that its decoder interprets as a huge unsigned value | Encodes a float               |
| Exact floating-point `30`, `0`, or `1` | No way to distinguish these from integer values                               | Explicit `OpackFloat` wrapper |
| Session identifier with bit 63 set     | Encoder throws despite decoder supporting unsigned 64-bit values              | Unsigned bigint encoding      |
| Reply using OPACK object references    | Decoder rejects the pointer tag                                               | Per-message reference table   |

Encrypted frame lengths also excluded the authentication tag, delaying or
corrupting reception. The candidate counts the tag on both send and receive.
Companion also places its encryption counter at byte zero of the 12-byte nonce;
the library reused the HAP/AirPlay layout with four leading zero bytes. This
breaks the second encrypted packet. The candidate uses the Companion layout
without changing HAP/AirPlay encryption.
The live TV also did not acknowledge request transaction zero. The library now
starts request IDs at one; a regression exercises successive request correlation.
The harness keeps its client session ID within the positive signed-32-bit range:
high-bit client IDs were accepted at startup but rejected at teardown by the TV.
The remote half still preserves all 32 bits in the combined unsigned-64-bit ID.
The controls stage also fixes three reproduced library failures: an unsolicited
event could consume a pending request with the same transaction ID; outbound
events omitted transaction IDs; and discovery lost the Companion port when that
mDNS advertisement arrived before AirPlay. Regression tests cover both service
orders and event/request collisions.

The upward close gesture initially bounced back on the real TV. The replacement
now matches the locked pyatv implementation's motion, timestamp origin, and
release sequence. An independent test executes pyatv itself with controlled
clocks and compares all four directions under normal, jittered, and stalled
timers (12 traces); the old Node implementation fails this comparison. Companion
TCP sockets also disable Nagle buffering, matching Python asyncio's low-latency
socket behavior. These corrections still require a physical close-app repeat;
the failed gesture's exact physical cause is not yet proven.

Eight regression tests reproduced the numeric, reference, and framing failures
before the changes. The extended library suite passes with the candidate.
Golden app-list and numeric packets were generated independently with the locked
pyatv 0.18.0 codec; the pointer tests also use its published protocol example.
Encrypted packets use a public synthetic key and pyatv's Chacha20Cipher. Tests
exercise complete, fragmented, and coalesced frames with advancing counters.
The first packet fixtures inadvertently used pyatv's default HAP nonce layout.
An independent loopback session caught that mistake; regenerated fixtures use
`nonce_length=12`, as pyatv's actual Companion connection does. Both the send and
receive regression checks failed before correcting the library's counter layout.

The source changes and regression tests are in `upstream-opack.patch`, based on
upstream commit `5e39c1e219f020d51aa0b051694f65b1edda5431`. The Yarn patch under
`patches/` applies the corresponding compiled JavaScript, declarations, and source
maps to the published npm package. This makes the experiment reproducible without
a local filesystem dependency or an unpublished package. No upstream submission
or permanent fork decision is implied.

## Run offline

Use this repository's Node 22 and Yarn 4 toolchain:

```sh
yarn install --immutable
yarn build
node --test tests/node-prototype.test.mjs
yarn test
uv run --python 3.13 --locked python experiments/node-library/loopback-peer.py
```

The last command runs a synthetic, loopback-only pyatv peer against the Node
library's real TCP pairing and encryption path. It checks pairing, fresh sessions,
navigation/media commands, power, exact seeks, volume, mute restoration with a
synthetic output identity, all four swipes, events, and teardown. A second client
has TCP dropped after a button-down reaches the peer; it reconnects, never replays
that action, and accepts new input. Python is the independent
test oracle here; the live Node harness does not invoke it. CI runs this check.

Queue regressions also cover a response timeout while TCP stays open: pending
input is invalidated before the queue advances after control, volume, or health
failures. A failed release cannot mask uncertain delivery of a button-down, and
stopping a controller prevents already-scheduled volume refreshes.

To verify the library source patch in a separate checkout of the exact upstream
commit, apply `upstream-opack.patch`, then run the upstream `npm install`,
`npm test`, and `npm run build` commands. The source patch includes its tests.

## Supervised device test

The development harness requires a Node 22 terminal on macOS or Linux. It is not
the proposed end-user setup UI. Use a new private directory outside all repositories,
then select the exact Apple TV ID from discovery:

```sh
node dist/prototype/live.js scan
node dist/prototype/live.js pair --device DEVICE_ID --credentials /private/directory/test.json
node dist/prototype/live.js check --credentials /private/directory/test.json
```

`pair` starts PIN pairing on that TV and accepts four digits through hidden terminal
input. It writes a separate mode-0600 credential file without replacing an existing
file, then opens a new connection to verify the credentials. If this verification
fails, the saved test credentials remain available for diagnosis with `check`.
Never provide credentials belonging to the working module.

`check` rediscovers the saved device ID and its current Companion port, performs
pair verification, exchanges controller information, starts a remote session,
lists apps, and queries power. A rejected power query reports `Unknown`. It reports
the app count rather than dumping the installed apps or protocol payloads. Success
also requires acknowledgement of session teardown. Both paths close the socket
on failure or cancellation. Network operations and PIN entry are bounded; no
operation reconnects or retries automatically.

After the read-only check succeeds, a supervised app-launch test is available:

```sh
node dist/prototype/live.js launch --credentials /private/directory/test.json --app BUNDLE_ID
```

It verifies that the requested app appears in the TV's app list and sends one
launch request. An acknowledgement does not prove that the app appeared on screen;
the output explicitly leaves the physical result unverified. A failed or timed-out
control must not be replayed automatically.

Stop the harness with Ctrl-C. The installed module is never replaced or restarted.
Pairing adds a separate controller registration on the TV. Removing the local test
file does not revoke that registration; remove only the test controller in the
TV's paired-device settings when retiring the experiment. Preserve existing
controller registrations and the production credentials.

## Controls and persistent-session pilot

`controller.ts` serializes complete gestures, bounds the queue to eight operations,
and expires input after 500 ms waiting in the queue. A failed or lost session
invalidates queued input and feedback. Reconnection rediscovers the selected TV
with bounded backoff; it never repeats a control. Idle health checks share the
queue, so they cannot interrupt a button-down/up pair or swipe.

The command layer supports navigation, Select, Back, Home, Home hold, App Switcher,
Control Center, play/pause, play, pause, next/previous, relative and absolute volume,
explicit seek intervals, reported-state power toggling, and 100 ms cardinal swipes.
Power events remain subscribed when the initial power query is rejected. Unknown
power never becomes a guessed toggle; pushed state used as fallback expires after
30 seconds. Playback capability updates can reject unavailable media commands
before transmission.

Use the existing separate pairing for a read-only status pilot:

```sh
node dist/prototype/controls-live.js --credentials /private/directory/test.json --seconds 10
```

For a supervised test, add exactly one explicit action, for example `--button up`,
`--button appSwitcher`, `--swipe left`, or `--seek 10`. `--help` lists the actions.
The output distinguishes completed dispatch from unverified physical effect.

Mute restoration is implemented and tested against synthetic outputs, including
output changes, external volume changes, and disconnects. It is deliberately
unavailable in the live pilot until a separate authenticated metadata connection
identifies the current audio output. The Companion-only volume reply does not
establish that identity. Now Playing and that metadata connection are not yet
wired into this pilot.

The normal Companion entry point still uses Python. The new controller and CLI
are development tools, not an installed replacement or the final pairing UI.

### Prepare before asking for physical observation

Build and test the code first, then finish the conversation turn with the exact
sequence and wait for the owner to say they are watching. Do not start a device
test or ask the owner to watch partway through a coding turn.

The acceptance runner previews offline by default. This command does not
read credentials, discover devices, or open a network connection:

```sh
node dist/prototype/acceptance-live.js --app YouTube
```

After the owner confirms they are watching, run the already-prepared command:

```sh
node dist/prototype/acceptance-live.js --app YouTube --mode close-app --run --credentials /private/directory/test.json --report /private/directory/close-app.json
```

The default `close-app` mode checks that the TV reports On and the app name
uniquely matches an installed app. It foregrounds that app, opens App Switcher,
swipes up, and stops. Every control has a five-second observation pause. It does
not require volume support or send volume or power controls.

The explicit `--mode remaining` sequence also requires reported volume between
5 and 95 percent. It tests volume down/up before closing the app, then explicit
sleep followed by explicit wake. Every power poll is recorded, including unknown
or unchanged values. Uncertain state cannot become a reversed power toggle.
Wake is not yet physically qualified; do not include this mode in the focused
close-app repeat.

Cancellation, a failed command, or connection loss stops remaining controls.
Nothing is retried, including the wake command. If it stops after sleep, use the
normal remote to wake the TV. The private report is created before controls and
never overwrites another report. Command acknowledgements and reported power
remain separate from owner-observed results.

### Pilot evidence (September 26, 2026)

Separate PIN pairing completed on one Apple TV. Fresh Node sessions discovered
22 apps, reported power as `On`, and received session-teardown acknowledgements.
One Plex launch request was acknowledged and its session closed cleanly; physical
screen confirmation was provided by the owner and recorded in the draft PR. The normal Companion
module, its credentials, and its packaged artifact were not replaced.

The controls-stage read-only pilot received live power, capability, and volume
updates without reconnects. Closing only that test client's socket then exercised
rediscovery and automatic reconnection to the real TV. No control was sent during
those checks. Later supervised runs supplied the physical results below.

The owner subsequently accepted navigation, horizontal swipes, Select, Home,
Control Center/Back, Twitch Play/Pause, and YouTube -10/+10-second seeks. The
remaining-controls run failed: the owner saw the YouTube card bounce instead of
close, and the TV stayed off after the acknowledged wake. Volume was not
physically confirmed. One separately requested Home press recovered reported
power to On in fresh Node and installed-module checks; physical recovery remains
an owner observation. The close-app corrections and direct wake remain
unqualified. No automatic control retry or installed-module change was made.

This qualifies an initial developer pilot on that device. It does not qualify
all controls, tvOS versions, supported operating systems, or end-user installation.

## Remaining qualification

Offline tests prove encoding, command composition, and the bounded session
lifecycle against a fake connection. They do not prove the TV accepts a command,
changes physical state, or behaves correctly after reconnect.
A returned request acknowledgement is not physical confirmation.

Before this can replace the worker, it still needs:

- Discovery and PIN pairing inside Companion, using its connection secret store.
- Integration of the persistent controller into Companion, extended lifecycle
  qualification, and supervised acceptance of navigation, swipes, media, and power.
- Authenticated audio-output tracking before enabling live volume restoration.
- Now Playing integration through the library's AirPlay/MRP connection.
- Packaged installation tests on the intended operating systems, followed by
  supervised Apple TV acceptance with separate pairing and preserved rollback.

The installed Python-backed connection and its credentials are outside this
prototype. Fixing its existing setup instructions is a separate change.

## References

- [Upstream public API](https://github.com/energee/node-appletv-remote/blob/5e39c1e219f020d51aa0b051694f65b1edda5431/src/appletv.ts)
- [pyatv Companion API reference implementation](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/companion/api.py)
- [pyatv media and power commands](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/companion/__init__.py)
- [OPACK protocol and reference examples](https://pyatv.dev/documentation/protocols/#opack)
- [pyatv encrypted frame implementation](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/companion/connection.py)
- [Node TCP no-delay behavior](https://nodejs.org/docs/latest-v22.x/api/net.html#socketsetnodelaynodelay)

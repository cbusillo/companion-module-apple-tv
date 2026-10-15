# Node library extensions and qualification

These are reproducible extensions to `node-appletv-remote` 0.4.0, with offline
tests and a separate, explicit-target live harness. Version 0.5 integrates the
controller into Companion's normal entry point and bundles the patched library.
Development builds run in the Director's Companion; the earlier Python
environment, keys and package are kept as rollback material. See the root
README for the normal-user discovery and PIN flow.

## Library 0.4.0 baseline

The module depends on the published npm `node-appletv-remote@0.4.0` (tag
`v0.4.0`, `7a557f72`). Building that tag reproduces the published `dist`
exactly. Release 0.4.0 already contains the Companion compatibility work this
module first carried as a patch: the OPACK float, unsigned 64-bit and pointer
support, `0x07` as -1, tag-inclusive frame lengths, the Companion nonce layout,
request IDs 1 to 127 with timed-out IDs reserved for 30 seconds, event/request
separation, transaction IDs on outbound events, discovery port matching in either
advertisement order, skipped empty frames and Nagle disabled. Release 0.4.0 also
wraps bare Companion content in the `{ _i, _t, _c, _x }` envelope. The module
already sends prebuilt `{ _t, _c }` envelopes; the library copies those and only
sets `_i` and `_x`, so the bytes sent are unchanged.

Test build 0.5.1-dev.8 bundles energee's unreleased default branch at `5cfc6af`
(through #63) instead; 0.5.1-dev.6 and dev.7 used `a189ea6`. That branch already covers what this module used
to patch for the AirPlay lifetime (cancellable setup through `close()`,
CSeq-correlated RTSP and identifier-correlated MRP replies, non-fatal reply
timeouts, a single outstanding heartbeat, full cleanup), the `errorCode` and
`errorDescription` fields, the player, client-removal, grouped-output and
cluster-identity schemas, `ModifyOutputContextRequest`, and the Companion
connection's cancellable setup. The module now uses those upstream APIs: it
closes the connection to cancel setup, reads `errorCode` from replies, silences
the AirPlay progress log in a subclass, and subscribes to output-device updates
itself after connecting.

Since `a189ea6`, energee's branch also delivers every protobuf in a batched
DataStream frame, one after another in wire order (#31), and declares
VolumeControlCapabilitiesDidChange (type 64) and reads volume capabilities
during the handshake (#53). The module's own versions of those changes are
dropped. The handshake now also sends GetVolumeControlCapabilities (62); the
module does not read its type 63 reply.

The remaining patch on `5cfc6af` adds only:

- GetVolume/GetVolumeResult messages (types 49 and 50) and `MRPMessage.getVolume`.
- An optional context type for `MRPMessage.modifyOutputDevices`; the module passes
  `SharedSystemAudio` (2).
- OPACK absolute time (`0x06`) decoded as pyatv 0.18.0 does, as an integer.
- Companion pairing lifetime: a `start({ signal })` cancellation, a `closed`
  promise for peer close while awaiting the PIN, a `stage` getter, immediate
  rejection on socket loss, and M6 identity signature verification.
- `MRPMessage` and `MessageType` exported from the package entry.

The upstream build requires `bplist-parser` 0.5, while the npm 0.4.0 manifest
asks for 0.3; `package.json` raises it through `resolutions`. The build no
longer imports `plist`.

Release 0.4.0 also adds high-level controls on its `AppleTV` class: MRP skip,
position, shuffle/repeat and `SetVolume`, plus Companion apps, accounts and power.
The module does not use that class. Its own Companion `_mcc` seek and volume
requests, app and power requests, queue and bounded sessions are what the TV has
accepted, so the wire behavior is unchanged. The 0.4.0 removal of the MRP
encryption class and MRP pair-verify path removed nothing the module uses.

The prototype composes app listing/launching, explicit seek intervals, absolute
volume read/write, and power-state queries through the library's public
`sendCompanionRequest` API. It does not access private transport internals.
The live harness supplies an authenticated session through the library's public
connection API. It does not read the installed module's configuration or credentials.

## Findings against 0.3.2

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
socket behavior. That owner-observed repeat still left the YouTube card visible.
The subsequent correction registers the
touch surface before starting tvremoteservices, following pyatv's session order,
and preserves that timestamp origin until disconnect. Previously the first swipe
registered touch lazily, after the remote session was already active. This
startup correction passed a supervised comparison at `60234aa`: the owner
confirmed that both the unchanged Python worker mapping and the Node candidate
removed the YouTube card using the same separate test pairing. The Node round
had zero reconnects. This qualifies closing on the tested TV; it does not isolate
startup order from timestamp age as the precise reason for the earlier failure.

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

The remaining source changes and their regression tests are in
`upstream-opack.patch`, based on energee commit `5cfc6af`. The Yarn patch under
`patches/` applies the corresponding compiled JavaScript, declarations, source
maps and bundled schema to the published npm package. The patch-only `.proto`
files are build input; the npm package carries no `.proto` files. This makes the experiment reproducible without
a local filesystem dependency or an unpublished package. No upstream submission
or permanent fork decision is implied.

## System audio output selection

`MRPMessage.modifyOutputDevices('set', outputDeviceUIDs, 2)` encodes MRP message type 48
(`ModifyOutputContextRequestMessage`, extension field 52) with context type
`SharedSystemAudio` (2) and the UIDs in both `settingDevices` and
`clusterAwareSettingDevices`. The context enum follows the Ghidra-derived protos
in pyatv#2834; pyatv 0.18.0 defines only `SharedAudioPresentation` (1), the
AirPlay speaker-group context that did not reliably select AirPods. Library tests
compare the encoding with pyatv-generated packets, and the metadata oracle
decodes a locked-pyatv packet built the same way as the supervised probe in
Media Control Relay #114. pyatv serializes the raw enum varint after the device
fields; this library emits canonical field order with the same decoded content.

A reply timeout from `sendMRPMessageAndWait` rejects only that wait, and a late
reply is ignored. The module relies on this for the route acknowledgement, which
tvOS can delay for many seconds during an AirPods takeover; an earlier library
closed the whole AirPlay session about three seconds after the press.

## Frames the library cannot use

The published parser decoded and delivered every encrypted frame inside one
`try` and reported any failure as a connection `error`. An authenticated frame
with an OPACK value the decoder lacks (for example tag `0x06`, a date, which
pyatv 0.18.0 decodes) therefore ended the Companion session, although the
stream was still in sync. An empty frame was also passed to decryption, which
failed and consumed a receive nonce, so every later frame failed too. pyatv
decrypts only non-empty frames and logs, rather than fails on, a frame it
cannot handle.

The library skips empty frames without consuming a nonce. In the dev.6 build an
authenticated frame that cannot be decoded ends the Companion connection, as
upstream intends; the patch decodes the `0x06` date as pyatv does, so that case
no longer ends it. Upstream closes a failed connection and then emits the error
that caused it, so the module waits one microtask after `close` and names that
error, with its code, in the session-loss log line. Which frame, if any, the TV
sends at the end of a list has not been observed.

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

Apple TVs read one-byte OPACK integers as signed. A request ID from 128 to 255
therefore came back changed: 255 returned as the one-byte -1 (`0x07`), which the
decoder rejected. The frame was dropped and the request timed out, ending the
session about every 255 requests (roughly every two hours of health checks;
issue #25). Release 0.4.0 keeps request IDs in 1 to 127, skipping any still
awaiting a reply, and decodes `0x07` as -1.

To verify the library source patch in a separate checkout of energee `5cfc6af`, apply
`upstream-opack.patch`, install with the upstream lockfile
(`pnpm install --frozen-lockfile`), then run `npm test` and `npm run build`. The
source patch includes its tests. The resulting `dist`, without `__tests__`, matches
the files the Yarn patch installs.

To regenerate the Yarn patch after changing the source patch: build the patched
checkout, run `yarn patch node-appletv-remote@npm:0.4.0`, copy the built `dist`
without `__tests__` into the printed directory, set `dist/cli/index.js` to mode
755, run `yarn patch-commit -s` on that directory, shorten the blob hashes on the
patch's `index` lines to seven characters, and run `yarn install`.

`.yarnrc.yml` preapproves exactly `node-appletv-remote@0.4.0` past the three-day
npm age gate, because it was published on October 14, 2026. The entry can be
removed after October 17, 2026; later versions remain gated.

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
queue, so they cannot interrupt a button-down/up pair or swipe. A seek queued
behind another request absorbs later seek ticks, netting opposite directions, up
to the 60-second request limit; the TV still receives one `_mcc` 7 per sent seek.

The command layer supports navigation, Select, Back, Home, Home hold, App Switcher,
Control Center, play/pause, play, pause, next/previous, relative and absolute volume,
explicit seek intervals, reported-state power toggling, and 100 ms cardinal swipes.
Power events remain subscribed when the initial power query is rejected. Unknown
power never becomes a guessed toggle. Status display may fall back to pushed
state for up to 30 seconds, but Wake and Toggle require a successful current
query. Wake sends one Home down/up pair only when the TV reports Off. It sends no
button when already On and stops for Unknown or a failed query. Explicit sleep
retains its dedicated command. Acknowledgements never set power to On; a later
query or pushed event must confirm it. Playback capability updates can reject
unavailable media commands before transmission.

Use the existing separate pairing for a read-only status pilot:

```sh
node dist/prototype/controls-live.js --credentials /private/directory/test.json --seconds 10
```

For a supervised test, add exactly one explicit action, for example `--button up`,
`--button appSwitcher`, `--swipe left`, or `--seek 10`. `--help` lists the actions.
The output distinguishes completed dispatch from unverified physical effect.

The controller now owns a Companion session and an authenticated AirPlay metadata
session together. Numeric volume comes from metadata; it never falls back to the
unqualified Companion volume reply. Absolute-volume writes still use Companion,
but require both an acknowledgement and a new matching metadata volume report.
Repeated cached snapshots cannot confirm a write. Missing volume or capabilities
after an output change remain unavailable until the TV reports them again.

Mute restoration is bound to the complete output list and primary volume ID.
Output changes, capability loss, external volume changes and disconnects discard
the saved level. A volume command queued before an output change is rejected.
Metadata loss closes both sessions; recovery starts a new pair without replaying
input. At `bf981b9`, the owner accepted absolute volume down/restore and
mute/unmute on one unchanged output, with fresh matching reports and zero
reconnects. Output-change protection still requires its separate live test.

The same controller now backs the version 0.5 Companion candidate. The CLI remains
a developer tool with a separate credential file; normal setup uses Companion's
connection secrets and requires no terminal.

### Prepare before asking for physical observation

Build and test the code first, then finish the conversation turn with the exact
sequence and wait for the owner to say they are watching. Do not start a device
test or ask the owner to watch partway through a coding turn.

For the focused audio test, start audible playback on the original output and
keep that output selected. It lowers volume five percentage points, restores the
initial level, mutes, and unmutes, with five seconds between steps. Starting
volume must be reported between 10 and 95 percent. A missing confirmation,
output change, cancellation or connection loss stops the sequence. There is no
automatic cleanup write; use the normal remote if an interrupted test leaves the
output muted. No playback, app, power or output-routing command is sent.

```sh
node dist/prototype/acceptance-live.js --mode audio
node dist/prototype/acceptance-live.js --mode audio --run --credentials /private/directory/test.json --report /private/directory/audio.json
```

The first command is an offline preview. The second requires the owner to be
ready and writes a new private receipt; protocol confirmation is separate from
the owner's audible acceptance.

The focused output-change test mutes once, then observes a manual round trip to
another output and back for up to three minutes. Start audible playback at a
comfortable level, with authenticated volume between 10 and 95 percent. Once
muted, select the other output, return to the original one, then restore volume
with the normal remote after the result. The pilot requires the saved mute level
to be cleared on the changed output and to stay cleared after returning,
including five more seconds of observation and a recovered authenticated volume
reading on return. It records volume, mute-save state, and output phase in arrival
order. A volume update before changed output identity
keeps observation running; the receipt separately records whether the saved
level was already cleared before that identity changed. This establishes the
observed sequence without attributing an earlier clear to the later output event.
Neither a volume update nor capability loss alone counts as an output change.
Output identity comparisons stay inside the process; the receipt uses output
phases and revision numbers rather than device identifiers.

After a changed output identity, the metadata session renews its own volume
subscription (false, then true) and sends a correlated MRP `GetVolume` request.
Other metadata subscriptions remain enabled. Repeating an unchanged subscription
did not refresh the tested TV; toggling the volume subscription produced fresh
capability and volume reports. A separate read-only probe returned the same level.
These probes did not change volume, playback, power, or output selection.

While recovery is pending, numeric audio feedback and mute restoration stay
unavailable. Each result belongs to the output generation that requested it;
switching away and back cannot make an old reply current. Recovery is serialized,
and a further output change schedules one fresh read after the pending one ends.
Missing or invalid result fields remain unavailable rather than becoming zero.
The final read never rearms a saved mute level. Synthetic regressions cover
ordering, rapid round trips, absent/zero results, capability loss, failure and
cancellation. Qualification across a real output switch is still pending.

```sh
node dist/prototype/acceptance-live.js --mode audio-output
node dist/prototype/acceptance-live.js --mode audio-output --run --credentials /private/directory/test.json --report /private/directory/audio-output.json
```

Only the initial mute sends a volume control. The pilot never selects an output,
attempts unmute on a changed output, or automatically restores a level. A missing
round trip, connection change, cancellation or retained mute level stops the
test; restore volume with the normal remote afterward. Cancellation is triggered
after 210 seconds including startup, followed by bounded cleanup. This tests
saved-level invalidation during owner-operated routing, not automated AirPods selection.

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
The five-second sleep/wake cycle remains unresolved; use focused modes when
qualifying individual controls.

The focused `--mode volume` pilot requires an awake TV and reported volume
between 5 and 95 percent. Start audible playback manually before the supervised
run. It sends volume down once, waits five seconds, reads the reported level,
then sends volume up once, waits five seconds, and reads the final level. The
report retains the initial, intermediate, and final values separately from the
owner's audible observation. It sends no app, playback, swipe, power, mute, or
absolute-volume controls. A query error or connection change stops remaining
input without a compensating command.

```sh
node dist/prototype/acceptance-live.js --mode volume
node dist/prototype/acceptance-live.js --mode volume --run --credentials /private/directory/test.json --report /private/directory/volume.json
```

The focused `--mode power` pilot requires only an awake TV and tests sleep/wake
without app or volume controls. Preview it offline before requesting observation:

```sh
node dist/prototype/acceptance-live.js --mode power
```

After the owner is watching, run the prepared command with a new report:

```sh
node dist/prototype/acceptance-live.js --mode power --run --credentials /private/directory/test.json --report /private/directory/power.json
```

It sends sleep once, checks Off, requests Wake once, and checks On. Wake now uses
one Home press gated by a successful current query showing Off. After On is
confirmed, the pilot requests Wake again to check that an already-awake TV stays
unchanged; this second request must send no button. There is no extra Home
recovery. Unknown state, cancellation, connection change, or request failure
stops input. This power cycle failed its first physical run; see the evidence below.

For a supervised timing comparison, `--sleep-seconds 20` waits twenty seconds
after the Sleep acknowledgement before checking Off and requesting Wake. The
option accepts whole seconds from 5 to 30, defaults to 5, and is valid only for
power/remaining modes. Other observation pauses remain five seconds. Cancellation
or connection loss during the wait prevents Wake. This is a test setting, not a
delay or retry in the command layer.

```sh
node dist/prototype/acceptance-live.js --mode power --sleep-seconds 20
node dist/prototype/acceptance-live.js --mode power --sleep-seconds 20 --run --credentials /private/directory/test.json --report /private/directory/power-timing.json
```

The separate `--mode wake` pilot starts with the TV already Off. It sends no Sleep,
app, swipe, or volume control: request Wake, require reported On, then request
Wake while already On and check that the screen stays unchanged. It stops after
one unsuccessful wake. This isolates the wake action from a preceding sleep
transition; it does not add a delay or retry to the command layer.

```sh
node dist/prototype/acceptance-live.js --mode wake
node dist/prototype/acceptance-live.js --mode wake --run --credentials /private/directory/test.json --report /private/directory/wake.json
```

Cancellation, a failed command, or connection loss stops remaining controls.
Nothing is retried, including the wake command. If it stops after sleep, use the
normal remote to wake the TV. The private report is created before controls and
never overwrites another report. Command acknowledgements and reported power
remain separate from owner-observed results.

For a controlled comparison, the prepared Python reference runner uses the
unchanged worker's action mapping and the same separate Node test pairing. It
resolves the saved AirPlay device ID to the matching Companion service, validates
an awake TV and unique app, then performs the same three actions with five-second
gaps. It does not read or restart the installed module. Preview is offline:

```sh
uv run --python 3.13 --locked python experiments/node-library/close_baseline.py --app YouTube
```

After the owner agrees to watch **both** rounds, run the Python reference first:

```sh
uv run --python 3.13 --locked python experiments/node-library/close_baseline.py --app YouTube --run --credentials /private/directory/test.json --report /private/directory/python-close.json
```

If that command completes, run the prepared Node `close-app` command with a new
report path. Stop on a failed command; do not retry a control. In each round the
observable result is whether the YouTube card disappears. Remaining in App
Switcher is expected because neither sequence sends Home or Back afterward.
Record Python and Node acceptance separately. This reference is a developer
diagnostic; it adds no Python dependency to the candidate Node runtime.

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
power to On in fresh Node and installed-module checks. The owner later reported
YouTube playing. After the touch-startup correction, the owner separately
confirmed Python and Node removed the YouTube card in the two-round comparison.
The focused power test at `00b8eec` then reproduced the direct-Wake failure:
the acknowledged command left power Off through all ten polls. A fresh Off check
gated one Home recovery, which reported On. The owner confirmed that the screen
turned off and came back on. Sleep and Home recovery are accepted on this TV;
the direct-Wake test remains failed. There were zero reconnects. The replacement
Wake now uses the observed Home behavior with an Off-state guard, but that
integrated action failed the next power cycle at `73cf295`: it ran five seconds
after Sleep, all ten polls stayed Off, and the owner confirmed the TV remained
off. The already-On check was not sent. The possible brief screen flicker was
uncertain and is not accepted as a wake. The earlier successful Home recovery
ran about twenty seconds after Sleep. This timing difference is a hypothesis,
not an established cause. A wake-only test from an already-asleep TV was then used
to separate those cases. It passed at `11a1dda`: reported power changed
from Off to On after about six seconds, remained On after the already-On check,
and the owner confirmed the screen woke and then stayed unchanged. There were
zero reconnects. Wake from the existing off state and already-On behavior are
accepted on this TV. The twenty-second Sleep observation test then passed at
`6bf0565`: Sleep reported Off, Wake reported On about six seconds after its
request, and the already-On check remained On, with zero reconnects. The owner
confirmed the sequence worked and explicitly accepted waking to the Home screen
instead of returning to the Twitch stream. Wake does not resume the previous
stream. The earlier five-second cycle failure remains unresolved: no minimum
safe interval or cause is established, and no command-layer timing change is
claimed as a fix. The owner-run focused volume test at `1d4cdc8` is accepted:
the owner heard the level go down and then up, and the session had zero reconnects.
Companion numeric feedback remained 50 before, between, and after those presses.
This accepts relative volume control only; that numeric feedback is unqualified.
No automatic control retry or installed-module change was made.

This qualifies an initial developer pilot on that device. It does not qualify
all controls, tvOS versions, supported operating systems, or end-user installation.

## Read-only metadata pilot

The same separate Companion pairing also authenticates the AirPlay metadata
connection on the tested TV; no second PIN or registration was needed. An initial
Node request timed out while locked pyatv returned volume and output identity.
Two library defects were reproduced: DataStream parsing discarded all but the
first protobuf in each batch, and absent protocol definitions discarded volume,
active-player, and removal messages. The patch preserves every message in wire
order, decodes the missing fields, subscribes to output updates, and distinguishes
untyped acknowledgements from media commands. DeviceInfo also accepts the shorter
records used for grouped outputs. Corrupt DataStream input and data/event channel
loss now surface as connection failures.

Independent synthetic pyatv packets cover the patched codec and metadata reducer.
The library's encrypted receive regression splits a coalesced pair of batches
across TCP chunks and checks all 24 messages and both acknowledgements. The
read-only live repeat received volume 30%, matching the Python reference, plus
authenticated output identity and capability messages. At `47b2070`, the owner
accepted the matching YouTube title, Playing/Paused/Playing transitions, and
volume feedback 30/25/30 while using the normal remote. At `a334413`, the owner
confirmed two AirPods round trips matched the authenticated output list during
a three-minute observation. The primary volume ID did not change. Volume and
capabilities temporarily became unavailable during those transitions. This
qualifies output-list feedback for that sequence; agent-initiated output
selection, per-route volume accuracy and position interpolation remain
unqualified. No agent-sent control was involved.

The new pilot follows explicit active-client/player selection, merges partial
content updates, ignores other outputs' volume, requires absolute-volume
capability for numeric feedback, and clears metadata after loss. Position is the
last reported position, not an extrapolated clock. Missing observations remain
unknown. It sends no app, power, playback, volume, output-routing, or pairing
commands; the owner can use the normal remote during an observation.

```sh
node dist/prototype/metadata-live.js
node dist/prototype/metadata-live.js --run --seconds 30 --credentials /private/directory/test.json --report /private/directory/metadata.json
node dist/prototype/metadata-live.js --run --seconds 180 --credentials /private/directory/test.json --report /private/directory/output-switch.json
uv run --python 3.13 --locked python experiments/node-library/mrp_fixtures.py | node experiments/node-library/metadata-oracle.mjs
```

The first command is an offline preview. Observation lasts 5-180 seconds after
connection, with a separate twenty-second startup limit. Ctrl-C or connection
loss stops it; it never reconnects. The receipt is created with mode 0600 without
overwriting, and can contain private titles and output identifiers. Terminal
output omits device identifiers. The library logger is disabled for this pilot.
The observer now connects directly and closes through the library's native
cancellation path. Completion, cancellation, failure, and report errors close the
session and clear feedback. Discovery cancellation also stops mDNS work. The
earlier worker-termination workaround is no longer used.

The library patch now separates encrypted fragments from partial plaintext RTSP
replies, processes coalesced replies, correlates CSeq and MRP identifiers, rejects
protocol errors, and registers pending replies before writing. Closing rejects
pending socket/authentication/write/request work and cancels heartbeat timers.
Only one heartbeat remains outstanding. Ten regressions failed against the prior
library before these repairs; additional tests cover simultaneous MRP requests,
late messages, cancellation during TCP connect, peer loss, heartbeat cleanup, and
discovery cancellation. Downstream CI exercises the installed npm patch's public
API against a stalled loopback peer as well as the metadata observation lifecycle.

Two earlier native read-only sessions against the TV each connected, observed metadata,
closed once without errors, and left no TCP sockets; the diagnostic process exited
naturally. These tests cover the reproduced transport defects. Longer outage/soak
coverage and installed Companion integration remain to be done. The persistent
prototype controller and standalone observer now share the metadata session's
cancellation and cleanup path. The independent encrypted Companion peer uses a
synthetic metadata connection for its reconnect/no-replay check; it does not
claim to reproduce an AirPlay server.
At the time of these runs the installed Python-backed connection was unchanged.
The version 0.5 candidate packages the Node controller and schemas, with native
cancellation through discovery, PIN entry, verification and shutdown. Pairing
verifies the accessory's M6 identity signature before returning keys. An
independent pyatv peer proves normal pairing and rejection of a deliberately
corrupted signature.

The prepared September 27 run at `1466163` used both native sessions. The owner
reported lower volume immediately after returning to AirPods, then the TV went
off, woke, and AirPods were muted. The output stage sent only its initial mute;
it discarded the saved level and renewed the metadata subscription after each
reported output change. Feedback recovered to 30% away and 0% on return. These
reports do not establish exact immediate per-route loudness. The power stage
used twenty seconds asleep and passed Off, On and already-On checks with zero
reconnects. A prior fifteen-minute read-only soak and three deliberately closed
test metadata sessions covered resource cleanup and recovery without controls.

Normal setup clears submitted PINs, saves keys only after fresh dual-session
verification, and preserves previous keys on failure. One-time migration keeps
button/variable IDs and disables old Python-config connections until a new PIN
pairing. Package tests load actual bundled schemas under package-only read
permissions. Now Playing uses reported position, timestamp and rate to advance
elapsed time; this is distinct from the CLI's raw reported-position observation.
Peer closure while awaiting a PIN immediately ends the prompt in Companion;
the TV can close earlier than the module's three-minute limit. Failures report
the PIN, identity or new-connection verification stage without logging private
protocol payloads. The independent peer exercises these paths through the
actual bundle as well as the installed patched library.

One earlier synthetic M4 failure remains unexplained at the exact-input level.
A retained diagnostic found that srptools and fast-srp-hap differ when an SRP
integer begins with a zero byte. Ordinary inputs agreed; that does not prove
which encoding the tested tvOS version accepts in the edge case. The packaged
success/closure/M6 identity-rejection fixture now uses reproducible synthetic
client randomness and a fixed synthetic server salt, so an unrelated M4 failure
cannot randomly prevent the identity-rejection test from reaching M6. This
fixture does not qualify leading-zero SRP interoperability. The ordinary
independent peer still uses random inputs; production randomness, SRP math and
the prohibition on automatic pairing retries are unchanged.

## Remaining qualification

Offline tests prove encoding, command composition, and the bounded session
lifecycle against a fake connection. They do not prove the TV accepts a command,
changes physical state, or behaves correctly after reconnect.
A returned request acknowledgement is not physical confirmation.

Development builds have run in the Director's Companion since October 2, 2026,
ending with 0.5.0-dev.10, which fixed the two-hour session drop (#25); the
Python package and keys are kept as rollback material. Personal audio output selection was qualified there with the
Director present: nearby and taken-over AirPods, AirPods in the case, TV-side
switches, sleep/wake and a Companion restart (Media Control Relay #114). There
is no tagged release; adopting an accepted release and retiring the local
prototype is tracked in shiny-infra-ops #313. Synthetic package coverage on an
operating system does not establish device/firewall/discovery behavior there.
The observed short sleep/wake timing limitation and the SRP edge-case
uncertainty remain explicit limitations for broader release qualification. The
installed connection and its credentials are outside the separate developer
harness.

## References

- [Upstream public API](https://github.com/energee/node-appletv-remote/blob/v0.4.0/src/appletv.ts)
- [pyatv Companion API reference implementation](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/companion/api.py)
- [pyatv media and power commands](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/companion/__init__.py)
- [OPACK protocol and reference examples](https://pyatv.dev/documentation/protocols/#opack)
- [pyatv encrypted frame implementation](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/companion/connection.py)
- [Node TCP no-delay behavior](https://nodejs.org/docs/latest-v22.x/api/net.html#socketsetnodelaynodelay)

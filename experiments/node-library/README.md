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
library's real TCP pairing and encryption path. It checks pairing and two fresh
sessions with app discovery, power reads, and teardown. Python is the independent
test oracle here; the live Node harness does not invoke it. CI runs this check.

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

## Remaining qualification

Offline tests prove encoding, command composition, and the bounded session
lifecycle against a fake connection. They do not prove the TV accepts a command,
changes physical state, or behaves correctly after reconnect.
A returned request acknowledgement is not physical confirmation.

Before this can replace the worker, it still needs:

- Discovery and PIN pairing inside Companion, using its connection secret store.
- Production session lifecycle beyond the single-session harness: event
  subscriptions, capability updates, bounded queues, and reconnect behavior.
- Touch/swipe behavior and gesture timing, plus volume restore that remains tied
  to the same output and is invalidated when output or session state changes.
- Power events when newer tvOS versions reject `FetchAttentionState`; an unknown
  power value must never be guessed into a toggle.
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

# Node library feasibility prototype

This is an offline prototype of extensions to `node-appletv-remote` 0.3.2.
The normal Companion entry point still uses the existing Python worker.
The candidate library is a development dependency, and the prototype is not
loaded by the connection or included in the Companion bundle.

The prototype composes app listing/launching, explicit seek intervals, absolute
volume read/write, and power-state queries through the library's public
`sendCompanionRequest` API. It does not access private transport internals.
It expects an authenticated, initialized Companion session supplied by a caller.
There is intentionally no device runner or credential reader in this experiment.

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

Eight regression tests reproduced the numeric, reference, and framing failures
before the changes. The extended library suite passes with the candidate.
Golden app-list and numeric packets were generated independently with the locked
pyatv 0.18.0 codec; the pointer tests also use its published protocol example.
Encrypted packets use a public synthetic key and pyatv's Chacha20Cipher. Tests
exercise complete, fragmented, and coalesced frames with advancing counters.

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
```

To verify the library source patch in a separate checkout of the exact upstream
commit, apply `upstream-opack.patch`, then run the upstream `npm install`,
`npm test`, and `npm run build` commands. The source patch includes its tests.

## Remaining qualification

These tests prove encoding and command composition. They do not prove the TV
accepts a command, changes physical state, or behaves correctly after reconnect.
A returned request acknowledgement is not physical confirmation.

Before this can replace the worker, it still needs:

- Discovery and PIN pairing inside Companion, using its connection secret store.
- Complete session initialization and teardown, event subscriptions, capability
  updates, bounded queues, cancellation, and reconnect behavior.
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

# Apple TV Companion module prototype

Prototype for retiring the Media Control Relay app when Companion can replace the required behavior. It uses a persistent, locally spawned Python/pyatv worker. No installed MCR app or MCR socket is used.

This is not yet a production replacement. Physical pairing, Apple TV dispatch, encoder response, reconnect, and Samsung/automatic-media-key parity remain unqualified. The module starts disabled and does not create pairings.

## Development

Use Node 22 and Yarn 4 (`npx --yes --package=@yarnpkg/cli-dist@4.17.0 yarn` is an alternative to installing Yarn globally).

```sh
yarn install
uv sync --locked
yarn build
yarn test
uv run python -m unittest discover -s tests -p 'test_*.py' -v
yarn lint
yarn package
```

## Pilot setup

1. Load the module into Companion, leaving Enable device connection unchecked.
2. Set the Python executable to the absolute path of this project's `.venv/bin/python`. The Python runtime is a pilot prerequisite, not silently downloaded on button presses.
3. Select an explicitly prepared credential JSON file with `host`, `identifier`, and `credentials`. The file must be regular, owner-owned, mode 0600, and outside any repository. Never export secrets from the MCR Keychain automatically or reuse HA credentials.
4. Only enable after the owner approves the exact physical pilot target. An existing pyatv storage file has a different schema and cannot be used directly. Pairing UI and secure credential provisioning are intentionally pending work.
5. Keep MCR available for rollback. Never run competing pilot button actions simultaneously.

One Remote command action exposes navigation, select, back, home, play/pause, previous/next, relative volume (one step), and seek (ten seconds). Each action requires the corresponding pyatv capability. No mute, power, text entry or app-launch support is claimed.

The connection variable reports session setup, not independently verified playback or device power. `last_result` distinguishes dispatch acknowledgement from physical state confirmation. Loss is detected on failed requests; idle liveness reporting is not yet qualified.

## Failure and lifecycle contract

- At most eight submitted actions; queued input expires after one second.
- At most one worker request in flight. An action timeout terminates the session; the result is unknown, never retried.
- Session generation changes discard old queued input and late results.
- Connection retries wait five seconds. They do not replay actions.
- Credentials travel over the private child pipe, never command arguments or module logs. Python diagnostics are suppressed; only bounded result categories are emitted.
- The worker has no network listener and does not persist credentials.

## Provenance

`bridge/controller.py` adapts the protocol adapter from the MIT-licensed `cbusillo/media-control-relay` AppleCompanionHelper/helper.py. Its license is preserved in LICENSE-MCR. This is source reuse, not a dependency on the MCR installed runtime. The new worker excludes discovery/pairing operations from its public request surface. pyatv 0.18.0 is locked in uv.lock. Bitfocus's official TypeScript module template is retained in git history.

## Retirement gate

Do not uninstall MCR until Apple TV pairing/session/reconnect and real usage, Samsung volume/mute routing, automatic physical-media-key behavior (or explicit owner retirement), shutdown outcomes, login startup and rollback have each been accepted. Host-specific profiles and credentials belong outside this repository. Owner layout edits must not be overwritten.

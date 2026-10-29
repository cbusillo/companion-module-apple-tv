# Apple TV Companion Module Agent Notes

## What Companion's Apple TV module does

This module lets Bitfocus Companion discover, pair with, and control Apple TV devices on the local network.
It provides remote buttons, app launching, and Now Playing variables, running in Companion's Node runtime.
Evidence: [README.md](README.md); the Hardware Safety rules below apply to all real-device work.

## GitHub Workflow

- Follow the shared [GitHub workflow](https://github.com/cbusillo/codex-skills/blob/main/skills/github/SKILL.md).
- Use normal merge commits. Do not squash or rebase pull requests.
- Use the focused `qualityGate.test.local` command in `.github/github.json`,
  replacing `{test_paths}` with affected Node test files after the build/type
  check. For Python reference-worker changes, select a module filename with
  `uv run python -m unittest discover -s tests -p '{test_pattern}' -v`.
- Run required lint and inspection. Safety, authorization, credential,
  destructive-helper and shared-infrastructure changes also run complete
  modules through changed code and callers, including the synthetic protocol
  and packaged-peer harnesses where affected. Record missing coverage.
- `qualityGate.test.ci` describes the complete existing CI build/test/package
  sequence; the `validation-gate` also requires macOS and Windows packaging.
  Wait for all current-head checks before `gh-pr.py ready`. The whole suite
  runs only in CI. Do not label or operate the train yourself.

## Hardware Safety

- Real Apple TV tests are opt-in and run only with the owner watching the TV.
  CI and unit tests use synthetic peers and fixtures.
- Never start pairing automatically or retry a pairing after an uncertain
  result. Pairing happens only after an explicit request.
- Never commit pairing keys, credentials, device identifiers, addresses, or raw
  captures. Use invented values.

## Engineering Defaults

- The packaged module is Node 22 and Yarn 4. Python is used only for the
  independent protocol oracle and the retained reference-worker tests; it is
  not part of the package.
- Keep README behavior claims in line with what tests and owner-observed
  hardware runs have actually shown.
- Do not propose an upstream or store submission until the owner has tested the
  change hands-on.

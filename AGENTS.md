# Apple TV Companion Module Agent Notes

## GitHub Workflow

- Treat `main` as a protected no-direct-work branch. Create a focused task
  branch, push it, and open a pull request.
- Pull requests land through the Launchplane merge train with the
  `ready-to-merge` label. Do not merge them directly.
- Use normal merge commits. Do not squash or rebase pull requests.
- Run the gates in `.github/github.json` before review. The `Validation`
  workflow and the Companion module checks must pass on the current PR head.

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

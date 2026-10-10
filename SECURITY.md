# Security Policy

## Supported Versions

Only the latest release of the module is supported. Fixes ship in a new release
built from `main`.

## Reporting a Vulnerability

Report suspected vulnerabilities privately through GitHub's
[Report a vulnerability](https://github.com/cbusillo/companion-module-apple-tv/security/advisories/new)
form. Do not open a public issue for a vulnerability.

Include the module and Companion versions, the impact, and the smallest steps
that reproduce it.

Do not send pairing keys, credentials, device identifiers, addresses, raw
captures, or other personal data. Use redacted or made-up values.

This is a single-maintainer project. Reports are handled on a best-effort
basis, and I aim to reply within seven days.

## Scope

Relevant reports include:

- exposing or logging pairing keys or credentials;
- starting pairing or sending commands without an explicit request;
- unsafe handling of data received from an Apple TV; and
- dependency or GitHub Actions supply-chain problems.

Problems in Apple TV software or in Bitfocus Companion itself should go to Apple
or Bitfocus.

# Security

Appgea Panel runs agents with your shell's permissions and keeps credentials in the macOS Keychain
and in `~/.appgeapanel/state/<module>/secrets/`. A bug in either is worth reporting.

## Reporting

Report privately through
[GitHub's security advisories](https://github.com/Appgea/panel/security/advisories/new).
Do not open a public issue.

Include what you found, the steps to reproduce it, and the commit you tested. Leave out real
credentials.

## Supported versions

Panel is an alpha with no releases. Only the latest `main` gets fixes.

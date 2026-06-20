# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
for this repository (the **Security → Report a vulnerability** tab). We aim to
acknowledge reports within a few days.

## Scope notes

- **Auto-update trust root.** Installed builds verify updates with a single
  minisign key pinned in `tauri.conf.json`. The key cannot be rotated without
  breaking auto-update for existing installs, so report any weakness in the
  update flow with care.
- **Untrusted input.** The app opens and decodes third-party CASC archives and
  the files inside them. Crashes, hangs, or memory-safety issues triggered by a
  crafted archive or file are in scope.

## Supported versions

Only the latest released version receives security fixes.

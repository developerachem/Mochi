# Security Policy

Thanks for helping keep Mochi and its users safe.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Instead, report them privately via GitHub's **[Security Advisories](https://github.com/DevZonayed/Mochi/security/advisories/new)** form. This sends the report directly to maintainers without exposing it publicly.

If you cannot use GitHub Security Advisories, email **dev.jonayed@gmail.com** with `[mochi-security]` in the subject line.

Include in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof-of-concept
- The affected version (commit SHA or release tag)
- Any suggested mitigations, if you have them

## What to Expect

- **Acknowledgement** within 72 hours
- **Initial assessment** within 7 days
- **Coordinated disclosure** once a fix is shipped — we will credit you in the advisory unless you prefer to remain anonymous

## Scope

In scope:

- The Mochi Chrome extension (`extension/`)
- The bundled MCP server (`server/`)
- The Continuum plugin hooks and CLI tools (`plugins/continuum/`)
- Build and release workflows (`.github/workflows/`)

Out of scope:

- Vulnerabilities in third-party dependencies — please report those upstream
- Issues that require physical access to a user's machine or compromised browser profile
- Findings from automated scanners without a working proof-of-concept

## Supported Versions

Security fixes are issued for the latest released version on the `Master` branch. Older versions are not maintained.

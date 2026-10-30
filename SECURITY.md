# Security policy

## Supported versions

Znight is released in lockstep: every `@znight/*` package shares one version. Until 1.0, security
fixes land in the latest minor version only.

| Version      | Supported |
| ------------ | --------- |
| latest `0.x` | ✅        |
| older `0.x`  | ❌        |

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately with GitHub's
[private vulnerability reporting](https://github.com/znight-org/znight/security/advisories/new)
(repository **Security** tab → **Report a vulnerability**). Include:

- the affected package(s) and version;
- a description of the issue and its impact;
- a minimal reproduction (code, configuration, requests);
- a suggested fix, if you have one.

The maintainers aim to acknowledge reports within a week. Once the issue is confirmed, a fix is
prepared in a private advisory, released as a new version of every `@znight/*` package, then the
advisory is published with credit to the reporter (unless you prefer to stay anonymous).

## Scope

In scope: the published `@znight/*` packages, including the code they generate at build time (the
dependency injection container, routes and validation wiring).

Out of scope: the example applications (`examples/`), which are not meant to be deployed as is, and
vulnerabilities of third-party dependencies that do not affect Znight (report those upstream).

## Supply chain

Releases are published from GitHub Actions only (`.github/workflows/release.yml`), after a
maintainer's approval. Every version carries an
[npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation linking it to
the commit and workflow run that built it: check it with `npm audit signatures`.

# Releasing Znight

Maintainer guide: how CI works, how versions are bumped, how packages reach npm and the
documentation reaches GitHub Pages, and what has to be configured on GitHub and npm. Contributors
only need the [pull request](#pull-requests) part.

| Workflow                                       | When                                                                         | What                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ci.yml`](.github/workflows/ci.yml)           | every pull request, every push to `main`, before every release               | Biome + actionlint (+ a changeset reminder), typecheck, build + pack verification, unit and example tests, docs build                         |
| [`ci-full.yml`](.github/workflows/ci-full.yml) | every pull request, every push to `main`, before every release, every Monday | e2e (production builds on Node.js 24 and Bun), Docker integration tests, packed-tarball smoke test (npm and Bun)                              |
| [`release.yml`](.github/workflows/release.yml) | every push to `main`, manual run                                             | the "chore: version packages" pull request; when a version is missing from npm: the gates, then **an approval**, publish, tag, GitHub release |
| [`docs.yml`](.github/workflows/docs.yml)       | after each stable release, manual run                                        | the documentation site on GitHub Pages                                                                                                        |

All jobs run on `ubuntu-latest`, install Bun from `package.json#packageManager` and Node.js 24
([`.github/actions/setup`](.github/actions/setup/action.yml)), and cache the Bun install cache by
`bun.lock`. A new push to a pull request cancels its previous runs; runs on `main` are never
cancelled.

## Pull requests

`main` is protected: every change, the maintainers' included, goes through a pull request whose
checks pass (see [the ruleset](#owner-setup-checklist)). CI and CI (full) run on every pull request:
Actions minutes are free for public repositories.

A pull request that changes a published package for its users (feature, fix, behaviour or
dependency change) adds a **changeset**:

```sh
bun run changeset        # pick the bump, write a one-line summary for the changelog
```

Versions and changelogs are managed with [Changesets](https://changesets.dev)
([`.changeset/config.json`](.changeset/config.json)):

- **Lockstep**: every `@znight/*` package is in one `fixed` group (`@znight/*`, except the private
  docs site). A changeset bumping one package bumps all of them to the same version, and the release
  script refuses to publish packages whose versions differ.
- **Bumps**: until 1.0, a breaking change is a `minor` bump and everything else a `patch`.
- **No changeset** for docs-, tests-, examples- or CI-only changes. CI posts a warning (never a
  failure) on a pull request that changes packages without a changeset, as a reminder.
- **Ignored**: the examples (`@znight-examples/*`) and the docs site (`@znight/docs`) are private and
  never versioned or published.
- Internal dependencies use `workspace:*` / `workspace:^` and third-party versions shared through
  the root catalog use `catalog:`; `bun pm pack` rewrites both to real versions in the tarballs.

## CI

### Fast checks (`ci.yml`)

| Job                  | Commands                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Lint & format        | `bun run check`, actionlint (Docker image `rhysd/actionlint`), changeset reminder (PR only) |
| Typecheck            | `bun run build`, `bun run typecheck`                                                        |
| Build & pack         | `bun run build`, `bun run release:pack`, `bun run release:status`                           |
| Unit & example tests | `bun run build`, `bun run test`, `bun run test:examples`                                    |
| Docs build           | `bun run docs:build`                                                                        |

The build runs before the typecheck and the tests because the examples call the `znight` binary,
which loads `packages/cli/dist/cli.mjs`.

`release:pack` packs every package exactly as it will be published and verifies the tarballs (see
[What the release script checks](#what-the-release-script-checks)). In pull requests a missing
package README is only a warning, so that packages in progress do not block unrelated work; the
release refuses to publish without it.

### Slow suites (`ci-full.yml`)

| Job                         | Commands                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| E2E (Node 24 + Bun)         | `bun run test:e2e`: every suite starts the production build on Node.js **and** on Bun, so one job covers both         |
| Integration (Docker)        | `bun run test:integration` (testcontainers: RabbitMQ, LocalStack SQS, Kafka), then the examples' e2e against RabbitMQ |
| Packed tarballs (npm / bun) | `bun run release:smoke --pm <npm or bun>`, see [Smoke test](#smoke-test)                                              |

They also run every Monday, to catch what changes without a commit (base images, brokers, the npm
registry), and on demand (**Actions → CI (full) → Run workflow**). The first e2e run needs the npm
registry: the `client:check` of `examples/storefront-api` runs `openapi-typescript` through
`npm exec`.

### Running it locally

```sh
bun run check && bun run typecheck && bun run test && bun run test:examples
bun run test:e2e                  # builds first
bun run test:integration          # needs Docker
bun run build && bun run release:pack      # pack + verify (add --strict to fail on missing READMEs)
bun run build && bun run release:smoke     # install the tarballs in a clean app (npm and Bun), run it
```

## Publishing

### How a release goes

1. **Changesets land on `main`** with the pull requests that need them.
2. **The version pull request.** On every push to `main`, the release workflow opens or updates the
   **"chore: version packages"** pull request (branch `changeset-release/main`): it runs
   `bun run version` (`changeset version`, which bumps every `package.json` and prepends to every
   `packages/*/CHANGELOG.md`, then `bun install` to refresh `bun.lock`). A pull request opened with
   the workflow's `GITHUB_TOKEN` triggers no workflow by itself, so the release workflow starts CI
   and CI (full) on it (`workflow_dispatch`, which the token may trigger): its checks show up on the
   pull request like on any other.
3. **The maintainer merges it** when a release is wanted. Changesets merged in the meantime are
   added to it.
4. **On that push**, the **Release plan** job finds the versions that are not on npm, then CI and
   CI (full) run again **on that exact commit** (called by the release workflow). If they pass, the
   **Publish to npm** job waits for an approval in the `npm` environment: GitHub notifies its
   required reviewers (**Review deployments**). The approval is the go of the release; rejecting it
   publishes nothing.
5. **The job publishes** every version that is not on npm yet, then creates the `vX.Y.Z` tag and
   GitHub release (notes gathered from the changelogs by [`notes.ts`](scripts/release/notes.ts)).
6. **The documentation** of that commit is deployed to GitHub Pages ([`docs.yml`](#documentation-site)),
   except for prereleases.

Publishing **never happens without an explicit go**: on a push, the publish job refuses to start if
the `npm` environment has no required reviewers. A manual run (**Actions → Release → Run
workflow**, on `main`, _Dry run_ unchecked) retries a failed release: same gates, same approval,
and the versions already on npm are skipped. Its **Dry run** option, checked by default, packs,
verifies and runs `npm publish --dry-run` without the gates and without publishing anything.

### What the release script does

[`scripts/release/publish.ts`](scripts/release/publish.ts) (`bun run release`, which builds first):

1. refuses to publish while changesets are pending (merge the version pull request first);
2. queries the registry and keeps the packages whose version is not published yet; refuses to move
   the `latest` dist-tag back to a lower version. Prerelease versions (`1.0.0-beta.1`) go to `next`;
3. packs **every** package with `bun pm pack` and verifies the tarballs (below); any error stops
   the release before anything is uploaded;
4. publishes the missing ones with `npm publish <tarball> --access public`, dependencies first
   (`core` → `compiler` → `http` → …). Versions already on npm are skipped, so a failed release is
   fixed by running the workflow again.

```sh
bun run release --dry-run      # everything except the upload (npm publish --dry-run)
bun run release:status         # version, pending changesets, versions missing from npm
```

#### What the release script checks

Each tarball ([`tarball.ts`](scripts/release/tarball.ts)) must have: the right name and version,
no `workspace:` or `catalog:` range left, internal dependency ranges that accept the lockstep
version, a `README.md`, a `LICENSE` (the root `LICENSE` is copied into packages without one for
the duration of the pack), a `dist/` folder, every `exports`/`main`/`types`/`bin` target present,
a shebang on the `bin` files, a `repository.url` pointing at `github.com/znight-org/znight` (npm
provenance compares them), and no `node_modules`, `.env`, `.npmrc`, `.tsbuildinfo` or `.znight`
files.

### Authentication and provenance

The publish step uses, in this order:

1. the **`NPM_TOKEN`** secret when it is set: an npm granular access token. It is only needed to
   [bootstrap](#first-release-010): npm trusted publishing can only be configured for a package
   that already exists on the registry;
2. otherwise **npm trusted publishing** (OIDC): the job has `permissions: id-token: write` and
   npm ≥ 11.5.1 (Node.js 24) exchanges the GitHub OIDC token for a short-lived publish token. No
   secret at all. npm checks the repository (`znight-org/znight`), the workflow file
   (`release.yml`) and the environment (`npm`) against the trusted publisher configured on each
   package.

**Provenance** (`--provenance`, a signed statement linking each version to its commit and workflow
run) is attested automatically: the workflow passes the repository visibility to the script
(`ZNIGHT_REPOSITORY_VISIBILITY`), and npm can only attest packages built from a public repository
(a private fork publishes without it, with a warning). The npm page of each version then shows the
provenance badge, and `npm audit signatures` verifies it.

### Smoke test

[`scripts/release/smoke.ts`](scripts/release/smoke.ts) checks the packages as users will get
them. In a temporary directory outside the workspace, with the `@znight` scope pointed at an
unreachable registry (so every `@znight/*` package can only come from a tarball):

1. installs `@znight/cli` from its tarball and scaffolds an application with `znight new`;
2. points the application's `@znight/*` dependencies and `overrides` at the tarballs, installs them
   with npm or Bun;
3. runs `znight generate`, `tsc --noEmit` (the published type declarations) and `znight build`;
4. starts `dist/main.js` on Node.js and on Bun, requests `GET /health` and `GET /greetings/Smoke`,
   stops it with SIGTERM and expects exit code 0.

```sh
bun run build && bun run release:smoke              # npm and Bun
bun run release:smoke --pm bun --keep               # one package manager, keep the directory
```

### Documentation site

The site (VitePress, [`docs/`](docs)) is deployed to **GitHub Pages** by
[`docs.yml`](.github/workflows/docs.yml), at
[znight-org.github.io/znight](https://znight-org.github.io/znight/):

- after each stable release, by the release workflow: the site documents the version on npm, never
  unreleased work on `main`;
- by hand (**Actions → Docs → Run workflow**, on `main`): the latest release by default, or the tag,
  branch or commit given in `ref`, e.g. to publish a fix of the docs between two releases.

The build gets the base path and the URL of the site from the Pages settings
(`actions/configure-pages`): `ZNIGHT_DOCS_BASE` (`/znight/` for the project site, `/` with a custom
domain) and `ZNIGHT_DOCS_URL` (sitemap and Open Graph URLs). Locally:

```sh
ZNIGHT_DOCS_BASE=/znight/ bun run docs:build && bunx vitepress preview docs
```

## First release (0.1.0)

Every package is already at `0.1.0` and nothing is on npm yet, so **the first release publishes the
current versions as they are**: the release workflow publishes whatever version is missing from
npm, it does not need a changeset. There is deliberately **no changeset for 0.1.0**: Changesets
always bumps (a changeset would turn `0.1.0` into `0.1.1` or `0.2.0` before anything is
published). The initial-release notes are written directly in each `packages/*/CHANGELOG.md` under
`## 0.1.0` (Changesets adds the next versions above them) and become the `v0.1.0` GitHub release.

**Merging the pull request that adds these workflows starts the release of 0.1.0**: on that push,
the plan finds 0.1.0 missing from npm, the gates run, and the publish job waits for an approval.
Prepare the [checklist](#owner-setup-checklist) first (at least the `npm` environment with its
reviewers and the `NPM_TOKEN` secret); otherwise reject the deployment, or let the job refuse to
start, and run the release by hand later.

1. **Dry run** (optional, once the workflows are on `main`): Actions → Release → Run workflow
   (`main`, _Dry run_ checked). Check the job summary.
2. **npm token** (bootstrap only): on npmjs.com → _Access Tokens_ → _Generate New Token_ →
   _Granular Access Token_: packages and scopes **Read and write** on the `@znight` scope, _Bypass
   two-factor authentication_ checked (CI cannot answer a 2FA prompt), expiration **7 days**. Save it
   as the **`NPM_TOKEN`** secret of the `npm` environment (Settings → Environments → `npm` →
   Environment secrets, or `gh secret set NPM_TOKEN --env npm --repo znight-org/znight`).
3. **Approve**: on the release workflow run, **Review deployments** → `npm` → **Approve and
   deploy**. It publishes the ten packages at 0.1.0 with the token (with provenance), creates
   `v0.1.0` and deploys the documentation.
4. **Trusted publishing**: now that the packages exist, configure them, logged in to npm with 2FA:

   ```sh
   npm install -g npm@latest              # npm trust needs npm >= 11.15
   npm login
   bun scripts/release/trust.ts           # prints one `npm trust github` command per package
   bun scripts/release/trust.ts --apply   # runs them
   ```

   Or by hand on npmjs.com, for every package: _Settings_ → _Trusted publishing_ → _GitHub
   Actions_: organization `znight-org`, repository `znight`, workflow `release.yml`, environment
   `npm`.

5. **Remove the token**: delete the secret (`gh secret delete NPM_TOKEN --env npm --repo
   znight-org/znight`) and revoke the token on npmjs.com. Then, for every package, _Settings_ →
   _Publishing access_ → **Require two-factor authentication and disallow tokens** (trusted
   publishing keeps working). Every later release uses OIDC only.

## Owner setup checklist

GitHub (repository `znight-org/znight`, public):

- [ ] **Actions may open pull requests**: Settings → Actions → General → Workflow permissions →
  **Allow GitHub Actions to create and approve pull requests** (the version pull request). If
  it is greyed out, allow it first at the organization level.
- [ ] **Ruleset on `main`** (Settings → Rules → Rulesets → New branch ruleset): require a pull
  request before merging, require status checks to pass (_Lint & format_, _Typecheck_,
  _Build & pack_, _Unit & example tests_, _Docs build_, _E2E (Node 24 + Bun)_,
  _Integration (Docker)_, _Packed tarballs (npm)_, _Packed tarballs (bun)_), block force pushes
  and deletions. Do not require the branch to be up to date with every merge unless you want
  to: the release re-runs every check on the merged commit anyway.
- [ ] **Environment `npm`** (Settings → Environments → New environment): _Required reviewers_: the
  maintainers (allow self-review while there is a single maintainer); _Deployment branches and
      tags_: `main` only; the **`NPM_TOKEN`** environment secret for the first release only.
- [ ] **GitHub Pages**: Settings → Pages → Build and deployment → Source: **GitHub Actions**. The
  `github-pages` environment it creates deploys from `main` (the release workflow and the
  manual runs both run on `main`).
- [ ] **Private vulnerability reporting**: Settings → Code security → Private vulnerability
  reporting → Enable (used by [SECURITY.md](SECURITY.md) and the issue template), or
  `gh api -X PUT repos/znight-org/znight/private-vulnerability-reporting`. Also enable
  Dependabot alerts, secret scanning and push protection on the same page.
- [ ] **Social preview**: Settings → General → Social preview → upload
  [`docs/public/social-preview.png`](docs/public/social-preview.png).
- [ ] **About**: description, homepage and topics, e.g.
  `gh repo edit znight-org/znight --homepage https://znight-org.github.io/znight/ --add-topic typescript --add-topic dependency-injection --add-topic compile-time --add-topic framework --add-topic nodejs --add-topic bun --add-topic vite`.
- [ ] **Discussions** (optional): Settings → General → Features → Discussions, then add a
  _Questions_ contact link to [`.github/ISSUE_TEMPLATE/config.yml`](.github/ISSUE_TEMPLATE/config.yml).

npm (organization `@znight`):

- [ ] Your npm account has 2FA enabled and can publish to the `@znight` organization.
- [ ] Granular token for the first release ([step 2](#first-release-010)), then trusted publishing
  on every package and the token revoked ([steps 4–5](#first-release-010)).
- [ ] A new package (a new `packages/*` folder) is published the first time with a token as well,
  then gets its trusted publisher.

## Troubleshooting

- **The version pull request has no checks**: the workflow could not start them (look at the
  _Start CI on the pull request_ step of the Release run). Run **CI** and **CI (full)** by hand on
  the `changeset-release/main` branch (Actions → workflow → Run workflow).
- **The version pull request is not opened**: enable _Allow GitHub Actions to create and approve
  pull requests_ ([checklist](#owner-setup-checklist)).
- **The publish job refuses to start ("no required reviewers")**: add reviewers to the `npm`
  environment, then re-run the job (or run the Release workflow by hand).
- **`npm publish` E404 / E403 with OIDC**: the trusted publisher of that package does not match
  (owner `znight-org`, repository `znight`, workflow file `release.yml`, environment `npm`, all
  case-sensitive) or the package has none yet (new package: publish it once with a token).
- **A release failed halfway**: run the Release workflow by hand (_Dry run_ unchecked); published
  versions are skipped and the GitHub release is created if it is missing.
- **"Pending changesets"**: merge the version pull request first (or, locally, `bun run version`).
- **The docs deployment failed** (Pages not enabled, a transient error): the packages are published
  anyway; enable Pages if needed, then run **Docs** by hand.
- **The site has broken styles or links**: it was built without the base path; check the _GitHub
  Pages settings_ step of the Docs run.

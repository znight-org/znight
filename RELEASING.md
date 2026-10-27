# Releasing Znight

Maintainer guide: how CI works, how versions are bumped, how packages reach npm, and what has to be
configured on GitHub and npm. Contributors only need the [changeset](#changesets) part.

| Workflow                                       | When                                                     | What                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`ci.yml`](.github/workflows/ci.yml)           | every pull request, every push to `main`                 | Biome + actionlint, typecheck, build + pack verification, unit and example tests, docs build                     |
| [`ci-full.yml`](.github/workflows/ci-full.yml) | every push to `main`, PRs labelled `ci:full`, manual run | e2e (production builds on Node.js 24 and Bun), Docker integration tests, packed-tarball smoke test (npm and Bun) |
| [`release.yml`](.github/workflows/release.yml) | every push to `main`, manual run                         | "chore: version packages" pull request; publishing to npm **only on a manual run** in the `npm` environment      |

All jobs run on `ubuntu-latest`, install Bun from `package.json#packageManager` and Node.js 24
([`.github/actions/setup`](.github/actions/setup/action.yml)), and cache the Bun install cache by
`bun.lock`. A new push to a pull request cancels its previous run.

## CI

### Fast checks (`ci.yml`)

| Job                  | Commands                                                          |
| -------------------- | ----------------------------------------------------------------- |
| Lint & format        | `bun run check`, actionlint (Docker image `rhysd/actionlint`)     |
| Typecheck            | `bun run build`, `bun run typecheck`                              |
| Build & pack         | `bun run build`, `bun run release:pack`, `bun run release:status` |
| Unit & example tests | `bun run build`, `bun run test`, `bun run test:examples`          |
| Docs build           | `bun run docs:build`                                              |

The build runs before the typecheck and the tests because the examples call the `znight` binary
(`packages/cli/dist/cli.mjs`); the setup action runs `bun install` again after the build to link it.
On a fresh clone, do the same locally: `bun install && bun run build && bun install`.

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

They run on every push to `main`, on demand (**Actions → CI (full) → Run workflow**) and on pull
requests that carry the **`ci:full`** label (add it to a PR to run them; new pushes run them again
while the label is there). They are not run on every pull request while the repository is private,
to save Actions minutes: set the repository variable **`CI_FULL_ON_PR=true`** (Settings → Secrets
and variables → Actions → Variables) to run them on every pull request, which is recommended once
the repository is public (minutes are free for public repositories).

The label is created once with:

```sh
gh label create ci:full --repo znight-org/znight --color 5319e7 --description "Run the slow CI suites (e2e, Docker, smoke) on this PR"
```

### Running it locally

```sh
bun run check && bun run typecheck && bun run test && bun run test:examples
bun run test:e2e                  # builds first
bun run test:integration          # needs Docker
bun run build && bun run release:pack      # pack + verify (add --strict to fail on missing READMEs)
bun run build && bun run release:smoke     # install the tarballs in a clean app (npm and Bun), run it
```

## Changesets

Versions and changelogs are managed with [Changesets](https://changesets.dev)
([`.changeset/config.json`](.changeset/config.json)):

- **Lockstep**: every `@znight/*` package is in one `fixed` group (`@znight/*`, except the private
  docs site). A changeset bumping one package bumps all of them to the same version, and the release
  script refuses to publish packages whose versions differ.
- **Ignored**: the examples (`@znight-examples/*`) and the docs site (`@znight/docs`) are private and
  never versioned or published.
- Internal dependencies use `workspace:*` / `workspace:^` and third-party versions shared through
  the root catalog use `catalog:`; `bun pm pack` rewrites both to real versions in the tarballs.

Any pull request that changes a published package for its users (feature, fix, behaviour or
dependency change) adds a changeset:

```sh
bun run changeset        # pick the packages and the bump, write a one-line summary for the changelog
```

Until 1.0, a breaking change is a `minor` bump and everything else a `patch`. Docs-, tests-,
examples- or CI-only changes need no changeset.

When changesets reach `main`, the release workflow opens or updates the **"chore: version
packages"** pull request: it runs `bun run version` (`changeset version`, which bumps every
`package.json` and prepends to every `packages/*/CHANGELOG.md`, then `bun install` to refresh
`bun.lock`). Merging that pull request is what makes a new version ready to publish.

> [!NOTE]
> Pull requests opened with the workflow's `GITHUB_TOKEN` do not trigger other workflows: the
> version pull request shows no CI checks. Close and reopen it, or run **CI** manually on the
> `changeset-release/main` branch, to get them (or give `changesets/action` a GitHub App token).

## Publishing

### How a release goes

1. Changesets are merged into `main` → the version pull request is opened and kept up to date.
2. The maintainer merges the version pull request. On that push, the **Release plan** job reports
   the versions missing from npm and annotates the run with "Ready to publish x.y.z".
3. The maintainer runs **Actions → Release → Run workflow** on `main`, first with **Dry run**
   checked if in doubt, then without it. The **Publish to npm** job runs in the `npm` environment
   (and waits for a reviewer's approval once the environment has required reviewers).
4. The job builds the packages, publishes every version that is not on npm yet, then creates the
   `vX.Y.Z` tag and GitHub release (notes gathered from the changelogs by
   [`notes.ts`](scripts/release/notes.ts)).

Publishing **never happens without an explicit action of the maintainer**: on a push, the publish
job only runs if the repository variable `NPM_PUBLISH_ON_PUSH=true` is set, and then it refuses to
start unless the `npm` environment has required reviewers (only possible once the repository is
public, see [Going public](#going-public)). The manual run always works and is the way to retry.

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
run) is only possible for packages built from a **public** repository. The workflow passes the
repository visibility to the script (`ZNIGHT_REPOSITORY_VISIBILITY`): while the repository is
private, packages are published without provenance and the job logs a warning; once it is public,
provenance is attested automatically, with nothing to change.

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

## First release (0.1.0)

Every package is already at `0.1.0` and nothing is on npm yet, so **the first release publishes the
current versions as they are**: the release workflow publishes whatever version is missing from
npm, it does not need a changeset. There is deliberately **no changeset for 0.1.0**: Changesets
always bumps (a changeset would turn `0.1.0` into `0.1.1` or `0.2.0` before anything is
published). The initial-release notes are written directly in each `packages/*/CHANGELOG.md` under
`## 0.1.0` (Changesets adds the next versions above them) and become the `v0.1.0` GitHub release.

Steps, in order:

1. **Packages ready.** `bun run build && bun run release:pack --strict` must pass: today
   `@znight/openapi` and `@znight/schedule` have no README, so the release refuses to publish
   (or mark a package `"private": true` to keep it out of 0.1.0).
2. **GitHub**: enable _Allow GitHub Actions to create and approve pull requests_ (see the
   [checklist](#owner-setup-checklist)).
3. **npm token** (bootstrap only): on npmjs.com → _Access Tokens_ → _Generate New Token_ →
   _Granular Access Token_: packages and scopes **Read and write** on the `@znight` scope, _Bypass
   two-factor authentication_ checked (CI cannot answer a 2FA prompt), expiration **7 days**. Save it
   as the **`NPM_TOKEN`** repository secret (`gh secret set NPM_TOKEN --repo znight-org/znight`).
   While the repository is private, environment secrets are not available on the Free plan: use a
   repository secret.
4. **Dry run**: Actions → Release → Run workflow (`main`, _Dry run_ checked). Check the job summary.
5. **Publish**: Actions → Release → Run workflow (`main`, _Dry run_ unchecked). It publishes the ten
   packages at 0.1.0 with the token (without provenance while private) and creates `v0.1.0`.
6. **Trusted publishing**: now that the packages exist, configure them, logged in to npm with 2FA:

   ```sh
   npm install -g npm@latest              # npm trust needs npm >= 11.15
   npm login
   bun scripts/release/trust.ts           # prints one `npm trust github` command per package
   bun scripts/release/trust.ts --apply   # runs them
   ```

   Or by hand on npmjs.com, for every package: _Settings_ → _Trusted publishing_ → _GitHub
   Actions_: organization `znight-org`, repository `znight`, workflow `release.yml`, environment
   `npm`.

7. **Remove the token**: delete the `NPM_TOKEN` secret (`gh secret delete NPM_TOKEN --repo
   znight-org/znight`) and revoke the token on npmjs.com. Then, for every package, _Settings_ →
   _Publishing access_ → **Require two-factor authentication and disallow tokens** (trusted
   publishing keeps working). Every later release uses OIDC only.

## Owner setup checklist

GitHub (repository `znight-org/znight`):

- [ ] Settings → Actions → General → Workflow permissions: check **Allow GitHub Actions to create
      and approve pull requests** (the version pull request). If it is greyed out, allow it first at
  the organization level (organization Settings → Actions → General).
- [ ] Label **`ci:full`** exists (command [above](#slow-suites-ci-fullyml)).
- [ ] Secret **`NPM_TOKEN`** (repository secret) for the first release only, deleted afterwards.
- [ ] Environment **`npm`**: created by the first publish run (or Settings → Environments → New
  environment). While the repository is private on the Free plan it cannot have protection rules
  or secrets: the gate is the manual run of the Release workflow.
- [ ] Optional variables: `CI_FULL_ON_PR=true` (slow suites on every PR), `NPM_PUBLISH_ON_PUSH=true`
  (queue the publish job on push; only once the `npm` environment has required reviewers).

npm (organization `@znight`):

- [ ] Your npm account has 2FA enabled and can publish to the `@znight` organization.
- [ ] Granular token for the first release ([step 3](#first-release-010)), then trusted publishing
  on every package and the token revoked ([steps 6–7](#first-release-010)).
- [ ] A new package (a new `packages/*` folder) is published the first time with a token as well,
  then gets its trusted publisher.

## Going public

When the repository becomes public:

- [ ] **Visibility**: Settings → General → Danger Zone → Change visibility → Public.
- [ ] **Branch protection** on `main` (Settings → Rules → Rulesets → New branch ruleset, or Branches):
  require a pull request, require the status checks _Lint & format_, _Typecheck_, _Build & pack_,
  _Unit & example tests_ and _Docs build_, block force pushes and deletions. (Not available for
  private repositories on the Free plan.)
- [ ] **`npm` environment**: Settings → Environments → `npm` → _Required reviewers_: add the
  maintainers (allow self-review while there is a single maintainer); _Deployment branches_:
  `main` only. From then on every publish waits for an approval.
- [ ] **Publish on push** (optional): set `NPM_PUBLISH_ON_PUSH=true` so that merging the version
  pull request queues the publish job, waiting for approval. Keep the manual run anyway: it is how
  to retry a failed release.
- [ ] **Provenance**: nothing to do, it turns on by itself (the workflow detects the public
  repository). Check after the next release: the npm page shows the provenance badge and
  `npm audit signatures` verifies it.
- [ ] **CI on every PR**: set `CI_FULL_ON_PR=true` (Actions minutes are free for public repositories).
- [ ] **Private vulnerability reporting**: Settings → Code security → Private vulnerability
  reporting → Enable (used by [SECURITY.md](SECURITY.md) and the issue template), or
  `gh api -X PUT repos/znight-org/znight/private-vulnerability-reporting`. Also enable Dependabot
  alerts, secret scanning and push protection on the same page.
- [ ] **Social preview**: Settings → General → Social preview → upload
  [`docs/public/social-preview.png`](docs/public/social-preview.png).
- [ ] **About**: description, homepage (docs site) and topics, e.g.
  `gh repo edit znight-org/znight --homepage <docs url> --add-topic typescript --add-topic dependency-injection --add-topic compile-time --add-topic framework --add-topic nodejs --add-topic bun --add-topic vite`.
- [ ] **Discussions** (optional): Settings → General → Features → Discussions, then add a
  _Questions_ contact link to [`.github/ISSUE_TEMPLATE/config.yml`](.github/ISSUE_TEMPLATE/config.yml).

## Troubleshooting

- **`npm publish` E404 / E403 with OIDC**: the trusted publisher of that package does not match
  (owner `znight-org`, repository `znight`, workflow file `release.yml`, environment `npm`, all
  case-sensitive) or the package has none yet (new package: publish it once with a token).
- **`Provenance generation ... requires 'public' source repository`**: the repository is private;
  the script turns provenance off from `ZNIGHT_REPOSITORY_VISIBILITY`: check that the workflow
  still passes it.
- **A release failed halfway**: run the Release workflow again; published versions are skipped and
  the GitHub release is created if it is missing.
- **"Pending changesets"**: merge the version pull request first (or, locally, `bun run version`).
- **`znight: command not found` in a fresh clone**: run `bun install` again after `bun run build`.

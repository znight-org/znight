# Releasing Znight

Maintainer guide: how CI works, how versions are bumped, how packages reach npm and the
documentation reaches GitHub Pages, and what has to be configured on GitHub and npm. Contributors
only need the [pull request](#pull-requests) part.

| Workflow                                       | When                                                                         | What                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`ci.yml`](.github/workflows/ci.yml)           | every pull request, every push to `main` (through `release.yml`), manual run | every check: lint, typecheck, build and pack, unit and example tests, docs build, e2e, Docker integration, packed tarballs                             |
| [`release.yml`](.github/workflows/release.yml) | every push to `main`, manual run                                             | CI on the pushed commit; the "chore: version packages" pull request; when a version is missing from npm: **an approval**, publish, tag, GitHub release |
| [`docs.yml`](.github/workflows/docs.yml)       | after each stable release, manual run                                        | the documentation site on GitHub Pages                                                                                                                 |

A push to `main` starts one workflow, **Release**: it runs CI on the pushed commit (its jobs appear
as _CI / …_ in the run) and gates the publication on it. `main` has no CI run of its own.

All jobs run on `ubuntu-latest`, install Bun from `package.json#packageManager` and Node.js 24
([`.github/actions/setup`](.github/actions/setup/action.yml)), and cache the Bun install cache by
`bun.lock`. A new push to a pull request cancels its previous run; runs on `main` are never
cancelled.

## Pull requests

`main` is protected: every change, the maintainers' included, goes through a pull request whose CI
passes: the [ruleset](#owner-setup-checklist) requires one check, `all-checks-complete`, which only
passes when every CI job did. Actions minutes are free for public repositories.

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

[`ci.yml`](.github/workflows/ci.yml) runs every check, in parallel jobs:

| Job                         | Commands                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Lint & format               | `bun run check`, actionlint (Docker image `rhysd/actionlint`), changeset reminder (PR only)                           |
| Typecheck                   | `bun run build`, `bun run typecheck`                                                                                  |
| Build & pack                | `bun run build`, `bun run release:pack`, `bun run release:status`                                                     |
| Unit & example tests        | `bun run build`, `bun run test`, `bun run test:examples`                                                              |
| Docs build                  | `bun run docs:build`                                                                                                  |
| E2E (Node 24 + Bun)         | `bun run test:e2e`: every suite starts the production build on Node.js **and** on Bun, so one job covers both         |
| Integration (Docker)        | `bun run test:integration` (testcontainers: RabbitMQ, LocalStack SQS, Kafka), then the examples' e2e against RabbitMQ |
| Packed tarballs (npm / bun) | `bun run release:smoke --pm <npm or bun>`, see [Smoke test](#smoke-test)                                              |
| all-checks-complete         | waits for every job above and fails unless all of them succeeded                                                      |

It runs on every pull request; on every push to `main`, called by the release workflow; and on
demand (**Actions → CI → Run workflow**).

`all-checks-complete` is the only check the ruleset of `main` requires, so the ruleset does not
change when jobs do: a new job is required once it is listed in the `needs` of
`all-checks-complete`. The job runs even when a job it waits for failed or was skipped (a skipped
required check would count as passed) and fails unless every one of them succeeded.

The build runs before the typecheck and the tests because the examples call the `znight` binary,
which loads `packages/cli/dist/cli.mjs`.

`release:pack` packs every package exactly as it will be published and verifies the tarballs (see
[What the release script checks](#what-the-release-script-checks)). In pull requests a missing
package README is only a warning, so that packages in progress do not block unrelated work; the
release refuses to publish without it.

The e2e job needs the npm registry: the `client:check` of `examples/storefront-api` runs
`openapi-typescript` through `npm exec`.

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
   `packages/*/CHANGELOG.md`, then `bun install` to refresh `bun.lock`). It is opened and updated
   with the workflow's `GITHUB_TOKEN`, whose events start no workflow by themselves: GitHub creates
   its CI runs in an approval-required state. Start them with **Approve workflows to run** on the
   pull request (after each update); their checks then count for the ruleset like on any other
   pull request.
3. **The maintainer merges it** when a release is wanted. Changesets merged in the meantime are
   added to it.
4. **On that push**, the **Release plan** job finds the versions that are not on npm (or that have
   no GitHub release yet: see [Troubleshooting](#troubleshooting)), while CI runs **on that exact
   commit**, like on every push to `main`. If it passes, the **Publish to npm** job waits for an
   approval in the `npm` environment: GitHub notifies its required reviewers (**Review
   deployments**). The approval is the go of the release; rejecting it publishes nothing.
5. **The job publishes** every version that is not on npm yet, then creates the `vX.Y.Z` tag and
   GitHub release (notes gathered from the changelogs by [`notes.ts`](scripts/release/notes.ts)).
6. **The documentation** of the `vX.Y.Z` tag is deployed to GitHub Pages
   ([`docs.yml`](#documentation-site)), except for prereleases.

Publishing **never happens without an explicit go**: on a push, the publish job refuses to start if
the `npm` environment has no required reviewers. A failed release is retried with **Re-run failed
jobs** on its run: same commit (a CI job that failed runs again), the approval again, and the
versions already on npm are skipped. A manual run (**Actions → Release → Run workflow**, on `main`,
_Dry run_ unchecked) does the same from the current `main`, CI included. Its **Dry run** option,
checked by default, packs, verifies and runs `npm publish --dry-run` without CI and without
publishing anything.

### What the release script does

[`scripts/release/publish.ts`](scripts/release/publish.ts) (`bun run release`, which builds first):

1. refuses to publish while changesets are pending (merge the version pull request first);
2. queries the registry and keeps the packages whose version is not published yet; refuses to move
   the `latest` dist-tag back to a lower version. Prerelease versions (`1.0.0-beta.1`) go to `next`;
3. packs **every** package with `bun pm pack` and verifies the tarballs (below); any error stops
   the release before anything is uploaded;
4. publishes the missing ones with `npm publish <tarball> --access public`, dependencies first
   (`core` → `compiler` → `http` → …). Versions already on npm are skipped, so a release that
   failed while publishing is finished by running it again.

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

The build gets the base path and the origin of the site from the Pages settings
(`actions/configure-pages`): `ZNIGHT_DOCS_BASE` (`/znight/` for the project site, `/` with a custom
domain) and `ZNIGHT_DOCS_URL` (the origin, `https://znight-org.github.io`, without the base path:
the build appends it for the sitemap and the Open Graph URLs). The checkout has the whole history,
for the "last updated" date of each page. Locally:

```sh
(export ZNIGHT_DOCS_BASE=/znight/ && bun run docs:build && bun run --cwd docs preview)   # http://localhost:4173/znight/
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

- [ ] **Actions may open pull requests** (the version pull request): Settings → Actions → General
  → _Workflow permissions_: keep _Read repository contents and packages permissions_ (the workflows
  declare what they need), check **Allow GitHub Actions to create and approve pull requests**,
  **Save**. If the checkbox is greyed out, do the same first in the organization settings
  (`https://github.com/organizations/znight-org/settings/actions`). Or:
  `gh api -X PUT repos/znight-org/znight/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.
- [ ] **Ruleset on `main`** (Settings → Rules → Rulesets → New ruleset → New branch ruleset):
  enforcement _Active_, target _Default branch_; **Require a pull request before merging**, with
  _Required approvals_ at **0** while there is a single maintainer (GitHub does not let authors
  approve their own pull requests: with 1 approval and an empty bypass list, nobody can merge their
  own pull request), or keep 1 and add **Repository admin** to the _Bypass list_ in _For pull
  requests only_ mode; **Require status checks to pass** with one check, **all-checks-complete**
  (source _GitHub Actions_; it appears in the picker once it has run on a pull request); **Block
  force pushes**; **Restrict deletions**.
- [ ] **Environment `npm`** (the approval of every release):
  1. Settings → Environments → **New environment**, name `npm` (lowercase) → **Configure
     environment**.
  2. _Deployment protection rules_: check **Required reviewers**, add your GitHub account (and the
     other maintainers). Leave **Prevent self-review** unchecked: the release starts from your own
     merge, which you must be able to approve. **Save protection rules**.
  3. _Deployment branches and tags_: **Selected branches and tags** → **Add deployment branch or
     tag rule** → _Ref type_ Branch, pattern `main` → **Add rule**.
  4. _Environment secrets_ → **Add environment secret**: name `NPM_TOKEN`, value the npm token of
     the [first release](#first-release-010) (or
     `gh secret set NPM_TOKEN --env npm --repo znight-org/znight`). Delete it after the first
     release.
- [ ] **GitHub Pages**: Settings → Pages → _Build and deployment_ → _Source_: **GitHub Actions**
  (instead of _Deploy from a branch_; ignore the suggested workflows). It is saved at once, and
  creates the `github-pages` environment, which deploys from `main` (the release workflow and the
  manual runs of Docs both run on `main`). Or:
  `gh api -X POST repos/znight-org/znight/pages -f build_type=workflow`. The site appears at
  `https://znight-org.github.io/znight/` after the first deployment.
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

- **The version pull request has no checks**: click **Approve workflows to run** on it (its runs
  wait for that, see [How a release goes](#how-a-release-goes)). Without the banner, close and
  reopen the pull request: that starts its CI. Runs started by hand (**Run workflow** on the
  `changeset-release/main` branch) do not count for the ruleset.
- **The version pull request is not opened**: enable _Allow GitHub Actions to create and approve
  pull requests_ ([checklist](#owner-setup-checklist)).
- **The publish job refuses to start ("no required reviewers")**: add reviewers to the `npm`
  environment, then re-run the job (or run the Release workflow by hand).
- **`npm publish` E404 / E403 with OIDC**: the trusted publisher of that package does not match
  (owner `znight-org`, repository `znight`, workflow file `release.yml`, environment `npm`, all
  case-sensitive) or the package has none yet (new package: publish it once with a token).
- **A release failed halfway** (some versions missing from npm, or every package published but no
  tag, GitHub release or docs): **Re-run failed jobs** on that Release run (within 30 days). The
  approval is asked again; published versions are skipped, then the tag, the GitHub release and the
  docs follow. Otherwise run the Release workflow by hand (_Dry run_ unchecked): its plan also
  finishes a version without a GitHub release, from the current `main`.
- **"Pending changesets"**: merge the version pull request first (or, locally, `bun run version`).
  Empty changesets (`changeset --empty`) do not count: they release nothing.
- **The docs deployment failed** (Pages not enabled, a transient error): the packages are published
  anyway; enable Pages if needed, then run **Docs** by hand.
- **The site has broken styles or links**: it was built without the base path; check the _GitHub
  Pages settings_ step of the Docs run.

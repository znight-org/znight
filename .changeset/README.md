# Changesets

This folder holds the pending [changesets](https://changesets.dev) of the repository: one Markdown
file per user-facing change, written with `bun run changeset` in the pull request that makes the
change.

- All `@znight/*` packages are released together at the same version (a `fixed` group in
  `config.json`): a changeset that bumps one package bumps them all.
- Examples (`@znight-examples/*`) and the docs site (`@znight/docs`) are private and ignored.
- While on `0.x`, use `minor` for breaking changes and `patch` for everything else.
- Docs-, tests-, examples- or CI-only changes need no changeset (CI only reminds you).

When changesets reach `main`, the release workflow opens or updates the "chore: version packages"
pull request and runs CI on it; merging it bumps the versions and writes the changelogs, then the
publication waits for a maintainer's approval. See [RELEASING.md](../RELEASING.md).

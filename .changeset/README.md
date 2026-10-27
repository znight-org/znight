# Changesets

This folder holds the pending [changesets](https://changesets.dev) of the repository: one Markdown
file per user-facing change, written with `bun run changeset`.

- All `@znight/*` packages are released together at the same version (a `fixed` group in
  `config.json`): a changeset that bumps one package bumps them all.
- Examples (`@znight-examples/*`) and the docs site (`@znight/docs`) are private and ignored.
- While on `0.x`, use `minor` for breaking changes and `patch` for everything else.

When changesets land on `main`, the release workflow opens (or updates) the "chore: version
packages" pull request; merging it bumps the versions and writes the changelogs. Publishing to npm
is a separate, manually approved step: see [RELEASING.md](../RELEASING.md).

# Contributing

## Adding Changes

1. Make your changes in a PR
2. If your change affects users (features, fixes, breaking changes), add a changeset:
   ```bash
   npx changeset
   ```
3. Commit the generated `.changeset/*.md` file with your PR

Skip the changeset for internal changes (CI, tests, docs, refactors with no API impact).

## Releasing

When changesets are merged to `main`, a "Version Packages" PR is automatically created/updated.

Merging that PR:
- Bumps the version in `package.json`
- Updates `CHANGELOG.md`
- Publishes to npm
- Creates a GitHub Release

You control when to release by choosing when to merge the "Version Packages" PR. Multiple changesets can accumulate before releasing.

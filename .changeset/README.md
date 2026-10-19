# Changesets

Add a changeset to every pull request that changes what a published package
ships: `pnpm changeset`, pick the packages, the bump type and write the line
that appears in their CHANGELOG.md. See the repository README ("Releasing") for
how versions, manifest.json and `gety` are updated from here. The catalog takes
no changesets; the release workflow generates it.

# @gety-connectors/catalog

The list of featured Gety connectors, official and community, for Gety's
connector gallery. The data is in the `getyCatalog` field of this package's
`package.json`, so Gety reads it with a single request for the registry's
version document
(`GET https://registry.npmjs.org/@gety-connectors%2Fcatalog/latest`) without
downloading the tarball:

```json
{
	"official": [
		{
			"package": "@gety-connectors/linear",
			"name": "Linear",
			"description": "Indexes Linear issues as searchable markdown documents.",
			"icon": "data:image/webp;base64,...",
			"version": "0.2.0",
			"publishedAt": "2026-10-19T08:00:00.000Z"
		}
	],
	"community": [
		{
			"package": "@acme/gety-jira",
			"name": "Jira",
			"description": "Indexes Jira issues.",
			"icon": "data:image/png;base64,...",
			"version": "1.2.0",
			"publishedAt": "2026-10-20T03:00:00.000Z",
			"author": { "github": "acme", "githubId": 1234567 }
		}
	]
}
```

- `official` lists the connectors in this repository's `connectors/`, in package
  name order; `community` lists the registrations in `community/`, sorted by
  `name` ignoring case. Both are always present and may be empty.
- `package` is the connector's npm package and `version` its registered version:
  install `<package>@<version>` to get the connector the catalog shows, with its
  manifest and permissions. For an official connector that is its `latest`
  version on npm; for a community connector, the exact version in its
  registration.
- `name` and `description` come from that version's manifest (an official
  connector's `manifest.json`, a community connector's `gety` field on npm);
  `icon` is the manifest's icon as a `data:` URL, from the repository or from
  the version's npm tarball. PNG icons larger than 128 px are downscaled to 128
  px; WebP icons must be at most 128 px in both dimensions.
- `publishedAt` is the time npm published `version` (ISO 8601, UTC).
- `author` is present on community entries only: the registered GitHub user name
  and that user's numeric GitHub id, which stays the same when the user is
  renamed.
- Changes to this shape are additive only: `getyCatalog` and its entries may
  gain fields, so ignore the ones you do not know. An incompatible change would
  use a new field name (for example `getyCatalog2`) instead of changing
  `getyCatalog`.

The package is generated after every release that publishes connectors, and on
every push to `main` with nothing to version or publish (such as a merged
community registration): the release workflow reads each official connector's
`latest` version and publish time and each community connector's registered
version from the registry, combines them with the official manifests at that
commit and the community registrations, and publishes a new patch version of the
catalog when the result differs from the published `getyCatalog`. An official
connector's new name, description or icon therefore reaches the catalog with
that connector's next release, a community connector's with the merged
registration of its new version. The catalog has no CHANGELOG; each connector's
own CHANGELOG.md describes its releases.

`packages/catalog/package.json` in the repository holds the package metadata
only. It is `private` so that changesets neither versions nor publishes it;
`scripts/catalog.ts` writes the published `package.json` with `version` and
`getyCatalog`.

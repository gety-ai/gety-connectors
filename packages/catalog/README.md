# @gety-connectors/catalog

The list of official Gety connectors, for Gety's connector gallery. The data is
in the `getyCatalog` field of this package's `package.json`, so Gety reads it
with a single request for the registry's version document
(`GET https://registry.npmjs.org/@gety-connectors%2Fcatalog/latest`) without
downloading the tarball:

```json
{
	"connectors": [
		{
			"package": "@gety-connectors/linear",
			"name": "Linear",
			"description": "Indexes Linear issues as searchable markdown documents.",
			"icon": "data:image/webp;base64,...",
			"version": "0.2.0",
			"publishedAt": "2026-10-19T08:00:00.000Z"
		}
	]
}
```

- `package` is the connector's npm package; install it to get its manifest and
  permissions.
- `name` and `description` come from the connector's `manifest.json`; `icon` is
  its icon as a `data:` URL (raster icons larger than 128 px are downscaled).
- `version` is the connector's `latest` version on npm, and `publishedAt` the
  time npm published that version (ISO 8601, UTC).
- Changes to this shape are additive only: `getyCatalog` and its entries may
  gain fields, so ignore the ones you do not know. An incompatible change would
  use a new field name (for example `getyCatalog2`) instead of changing
  `getyCatalog`.

The package is generated after every release that publishes connectors: the
release workflow reads each connector's `latest` version and publish time from
the registry, combines them with the connectors' manifests at the released
commit, and publishes a new patch version of the catalog when the result differs
from the published `getyCatalog`. A connector's new name, description or icon
therefore reaches the catalog with that connector's next release. The catalog
has no CHANGELOG; each connector's own CHANGELOG.md describes its releases.

`packages/catalog/package.json` in the repository holds the package metadata
only. It is `private` so that changesets neither versions nor publishes it;
`scripts/catalog.ts` writes the published `package.json` with `version` and
`getyCatalog`.

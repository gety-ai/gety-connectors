# Contributing

## Listing your connector in Gety

Gety's "Featured connectors" dialog has two tabs: "Official", the connectors in
this repository, and "Community", connectors published by anyone and registered
here. Both come from `@gety-connectors/catalog`
([packages/catalog](packages/catalog/README.md)). To list your connector under
"Community", open a pull request that adds one registration file.

### Before you register

Publish the connector to npm as a public package that Gety can install: its
`package.json` has a `gety` field holding the connector's manifest (with the
same `version` as the package), and the published files include the manifest's
`entry` and `icon`. The official connectors are examples:
[connectors/linear/package.json](connectors/linear/package.json) and its
`files`. Install it in Gety from npm (`<package>@<version>`) to check that it
works. How to build a connector:
[docs.gety.ai/build-a-connector](https://docs.gety.ai/build-a-connector).

### The registration file

Add `community/<id>.json`, where `<id>` is the manifest `id` of your connector:

```json
{
	"package": "@acme/gety-jira",
	"version": "1.2.0",
	"author": { "github": "acme" }
}
```

- `package`: the npm package name.
- `version`: the exact version to list (no range, no tag such as `latest`). Gety
  installs this version from the catalog.
- `author.github`: your GitHub user or organization name. Gety shows its avatar
  and `@acme`, linking to `https://github.com/acme`.

These are the only fields: a registration with any other field fails the check.
Everything else the catalog shows comes from the registered version on npm:

- the name and description are the `name` and `description` of that version's
  `gety` manifest (the first line of the description);
- the icon is the file that manifest's `icon` names, read from that version's
  npm tarball. It must be SVG, PNG or WebP; a PNG must be at most 2048 px in
  both dimensions and is downscaled to 128 px when larger than that, a WebP must
  be at most 128 px in both dimensions, and the icon must be at most 24 KiB
  after downscaling. Its file name (the last segment of `icon`) must be at most
  100 bytes, so that it fits a plain tar header: the catalog does not read the
  extended headers npm writes for longer names;
- the date is when npm published that version.

To change what the catalog shows, publish a new version and register it
([Upgrading and removing](#upgrading-and-removing)).

### What the pull request check verifies

`deno task community:check` (the "Check community registrations" step of the
Verify workflow) reads every registration and fails when any of these does not
hold, naming the file and the check:

- the file is `community/<name>.json` holding exactly `package`, `version` and
  `author.github`, with a valid npm package name, an exact version and a valid
  GitHub name;
- the package and that version exist on npm;
- that version's `package.json` has a `gety` manifest whose `id` is the file
  name and whose `version` is the registered version;
- the version's tarball matches its npm `sha512` integrity and contains the
  manifest's icon, and the icon can be converted under the rules above;
- the GitHub user exists.

Run it locally before opening the pull request (it needs
[Deno](https://deno.com); `GITHUB_TOKEN`, when set, is used for the GitHub API):

```sh
deno task community:check
```

### Review and publishing

Maintainers review the registered version, the code that Gety installs from the
catalog. Connectors may use full permission mode; Gety's install review shows
its warning as it does for any connector. After the pull request is merged, the
release workflow regenerates the catalog and publishes it (with the next release
of the official connectors when one is pending), and Gety lists the connector
the next time it reads the catalog.

The catalog is regenerated from every registration each time, so a registration
must keep passing the check: the catalog is not published while any registration
fails. The catalog stores your GitHub user's numeric id, which keeps your avatar
when you rename the account, but the name in `author.github` must exist: after a
rename, update it with a pull request.

### Upgrading and removing

The catalog lists only the registered version; publishing a newer version to npm
does not change it. To list a new version, open a pull request that changes
`version` in your registration. It is checked and reviewed like a new
registration. People who installed the connector update it in Gety as with any
npm connector, independent of the catalog.

To remove your connector, open a pull request that deletes its registration. The
catalog stops listing it; installed copies keep working.

## Changing the official connectors

See the [README](README.md) for the repository layout, the development commands
and the release flow. A pull request that changes what a package ships adds a
changeset (`pnpm changeset`).

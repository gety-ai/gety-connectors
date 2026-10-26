# Community connectors

Each file here registers one community connector for the catalog that Gety's
"Featured connectors" dialog lists under "Community". The file is named after
the connector's manifest `id` (`community/<id>.json`) and holds exactly these
fields:

```json
{
	"package": "@acme/gety-jira",
	"version": "1.2.0",
	"author": { "github": "acme" }
}
```

`deno task community:check` checks every registration on each pull request, and
the release workflow lists them in `@gety-connectors/catalog`. How to register a
connector, what the check verifies, and how to upgrade or remove a registration:
[CONTRIBUTING.md](../CONTRIBUTING.md).

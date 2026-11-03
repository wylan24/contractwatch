# contractwatch

Catch breaking API changes before they ship. contractwatch compares two versions of an OpenAPI spec and tells
you which changes will break existing clients: removed fields, changed types, new required parameters. It runs
on pull requests and leaves one comment saying what will break and why.

> Status: early alpha, private. See [PLAN.md](PLAN.md) for the roadmap.

## Quick start

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npm install
node src/cli.ts diff old.yaml new.yaml
```

Or compare your working copy with another branch:

```bash
node src/cli.ts diff api/openapi.yaml --base origin/main
```

```
contractwatch  api/openapi.yaml @ origin/main (v1.0.0) → api/openapi.yaml (v1.1.0)

Breaking (3)
  GET /pets
    ✖ query parameter species · new required query parameter species [required-parameter-added]
    ✖ response 200 body · [].tag was removed [property-removed]
  DELETE /pets/{id}
    ✖ DELETE /pets/{id} was removed [operation-removed]

3 breaking changes will break existing clients.
```

Exit codes: `0` nothing failing, `1` failing changes found, `2` contractwatch couldn't run.

## Options

| Option | |
| --- | --- |
| `--base <ref>` | Read the base spec from a git ref. Relative `$ref` files are read at the same ref. |
| `--format text\|markdown\|json` | What to print. |
| `--markdown <file>` / `--json <file>` / `--sarif <file>` | Also write these reports. |
| `--fail-on breaking\|warning\|never` | When to exit 1. Default `breaking`. |
| `--all` | List non-breaking changes too. |
| `--config <file>` / `--no-config` | Use another config file, or none. By default the nearest `.contractwatch.json` is used. |

## Breaking an API on purpose

Sometimes a break is the plan: an endpoint is retired, a field is renamed in a new version. Every change in the
report has a short id (`[operation-removed 3fa2c1d0]` in the terminal, the **Id** column in the PR comment).
Record the ones you mean in `.contractwatch.json` at the repository root:

```json
{
  "accept": [
    { "id": "3fa2c1d0", "reason": "DELETE /pets moved to /v2, clients notified", "expires": "2027-01-31" }
  ]
}
```

Accepted changes are still listed, with their reason, but don't fail the check. An acceptance stops applying after
its `expires` date, and contractwatch tells you when an entry no longer matches anything so it can be removed.
The file lives in the repository, so accepting a break goes through code review like any other change.

Other settings:

```json
{
  "rules": { "enum-value-added": "info", "format-changed": "off" },
  "ignore": ["/internal/**", "DELETE /admin/*"],
  "allowBreakingOnMajorBump": true
}
```

- `rules`: change a rule's severity (`breaking`, `warning`, `info`) or turn it `off`. Rule ids are listed under [Rules](#rules).
- `ignore`: skip operations. `*` matches one path segment, `**` any number; a method prefix is optional.
  Parameter names don't matter (`/pets/{id}` matches `/pets/{petId}`).
- `allowBreakingOnMajorBump`: breaking changes pass when `info.version` gets a new major version
  (or a new minor version in `0.x`), the semver way of saying "this release breaks things".

## Direction matters

The same edit can be safe or breaking depending on who sends the data. Removing a property from a **response**
breaks clients that read it. Removing it from a **request** doesn't: old clients keep sending it, and the server
ignores it (unless the schema rejects extra properties, which contractwatch also checks). contractwatch compares
every schema with that in mind:

- **Request**: the new schema must still accept everything the old one accepted.
- **Response**: everything the new schema can return must still be something the old one allowed.

It also understands `allOf` (moving properties into a shared base isn't a change), `oneOf`/`anyOf` (variants are
matched by shape, not position), `readOnly`/`writeOnly`, OpenAPI 3.0 `nullable` vs. 3.1 type arrays, recursive
schemas, and renamed path parameters (`/pets/{id}` → `/pets/{petId}` is the same operation).

## GitHub Action

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  api-contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: wylan24/contractwatch@v0
        with:
          spec: api/openapi.yaml
```

The report goes to the job summary. On pull requests with breaking changes or warnings it also posts a comment,
and edits that same comment on later pushes instead of adding new ones. Set `upload-sarif: 'true'` (with
`security-events: write`) to show changes as code-scanning alerts on the spec's lines.

Several specs? List them, one per line, or use a glob. Each gets its own comment:

```yaml
        with:
          spec: |
            services/billing/openapi.yaml
            services/*/api/**/*.yaml
```

| Input | Default | |
| --- | --- | --- |
| `spec` | (required) | Spec paths or globs, one per line or space-separated. |
| `base` | PR base branch | Git ref to compare against. On `push`, the previous commit. |
| `fail-on` | `breaking` | `breaking`, `warning` or `never`. |
| `comment` | `true` | Post and update the PR comment. |
| `upload-sarif` | `false` | Upload to code scanning. |

Outputs: `exit-code` (0/1/2), `breaking` (count across specs, not counting accepted ones) and `report-dir`
(one folder per spec with `report.json`, `report.md` and `report.sarif`).

> While the repository is private, other repositories can only use the Action after you allow it under
> **Settings → Actions → General → Access**.

## Rules

| Rule | Meaning | In a request | In a response |
| --- | --- | --- | --- |
| `spec-version-changed` | OpenAPI version changed | info | info |
| `operation-removed` | Operation removed | breaking | breaking |
| `operation-added` | Operation added | info | info |
| `operation-deprecated` | Operation deprecated | warning | warning |
| `operation-undeprecated` | Operation no longer deprecated | info | info |
| `security-added` | Operation now requires authentication | breaking | breaking |
| `security-changed` | Operation security requirements changed | warning | warning |
| `security-removed` | Operation no longer requires authentication | info | info |
| `required-parameter-added` | Required parameter added | breaking | breaking |
| `parameter-added` | Optional parameter added | info | info |
| `parameter-removed` | Parameter removed | warning | warning |
| `parameter-became-required` | Parameter became required | breaking | breaking |
| `parameter-became-optional` | Parameter became optional | info | info |
| `parameter-deprecated` | Parameter deprecated | info | info |
| `required-request-body-added` | Required request body added | breaking | breaking |
| `request-body-added` | Optional request body added | info | info |
| `request-body-removed` | Request body removed | warning | warning |
| `request-body-became-required` | Request body became required | breaking | breaking |
| `request-body-became-optional` | Request body became optional | info | info |
| `request-media-type-removed` | Request media type removed | breaking | breaking |
| `request-media-type-added` | Request media type added | info | info |
| `success-response-removed` | Success response removed | breaking | breaking |
| `error-response-removed` | Error response removed | info | info |
| `response-added` | Response added | info | info |
| `response-media-type-removed` | Response media type removed | breaking | breaking |
| `response-media-type-added` | Response media type added | info | info |
| `response-header-removed` | Response header removed | warning | warning |
| `required-response-header-removed` | Required response header removed | breaking | breaking |
| `response-header-added` | Response header added | info | info |
| `type-changed` | Type changed | breaking | breaking |
| `type-widened` | Type widened | info | breaking |
| `type-narrowed` | Type narrowed | breaking | info |
| `became-nullable` | Became nullable | info | breaking |
| `no-longer-nullable` | No longer nullable | breaking | info |
| `property-removed` | Property removed | warning | breaking |
| `property-removed-closed` | Property removed from a closed object | breaking | breaking |
| `required-property-added` | Required property added | breaking | info |
| `property-added` | Property added | info | info |
| `property-became-required` | Property became required | breaking | info |
| `property-became-optional` | Property became optional | info | breaking |
| `enum-value-added` | Enum value added | info | warning |
| `enum-value-removed` | Enum value removed | breaking | info |
| `enum-added` | Values restricted to an enum | breaking | info |
| `enum-removed` | Enum restriction removed | info | warning |
| `format-changed` | Format changed | warning | warning |
| `constraint-tightened` | Constraint tightened | breaking | info |
| `constraint-loosened` | Constraint loosened | info | warning |
| `pattern-changed` | Pattern changed | warning | info |
| `additional-properties-restricted` | Additional properties no longer allowed | breaking | info |
| `additional-properties-allowed` | Additional properties now allowed | info | warning |
| `variant-added` | oneOf/anyOf variant added | info | warning |
| `variant-removed` | oneOf/anyOf variant removed | breaking | info |

## Development

```bash
npm test          # node --test, runs the TypeScript sources directly
npm run typecheck
npm run build     # dist/ for the npm package
```

## License

MIT

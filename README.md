# contractwatch

[![npm](https://img.shields.io/npm/v/@wylan24/contractwatch)](https://www.npmjs.com/package/@wylan24/contractwatch)
[![CI](https://github.com/wylan24/contractwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/wylan24/contractwatch/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@wylan24/contractwatch)](LICENSE)

Catch breaking API changes before they ship. contractwatch compares two versions of an OpenAPI spec and tells
you which changes will break existing clients: removed fields, changed types, new required parameters. It runs
on pull requests and leaves one comment saying what will break and why.

It also checks a spec against reality: give it recorded traffic and it reports where the API's real responses
don't match what the spec promises.

> Status: early alpha. Rule ids and report formats may still change. See [PLAN.md](PLAN.md) for the roadmap.

## Quick start

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
npx @wylan24/contractwatch diff old.yaml new.yaml
```

Or compare your working copy with another branch:

```bash
npx @wylan24/contractwatch diff api/openapi.yaml --base origin/main
```

```
contractwatch  api/openapi.yaml @ origin/main (v1.0.0) → api/openapi.yaml (v1.1.0)

Breaking (3)
  Schema Pet
    ✖ Pet.tag was removed [property-removed ac9e2d62]
      in 3 operations: GET /pets, POST /pets, GET /pets/{petId}
  GET /pets
    ✖ query parameter species · new required query parameter species [required-parameter-added 415a461f]
  DELETE /pets/{id}
    ✖ DELETE /pets/{id} was removed [operation-removed 90bd04bb]

3 breaking changes will break existing clients.
If a break is intended, add its id to "accept" in .contractwatch.json with a reason.
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
Record the ones you mean:

```bash
npx @wylan24/contractwatch accept 90bd04bb --reason "DELETE /pets moved to /v2, clients notified" --expires 2027-01-31
```

That adds them to `.contractwatch.json` at the repository root (creating it if needed):

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

For completion and checks in your editor, point the file at the schema shipped in the package:
`"$schema": "./node_modules/@wylan24/contractwatch/schema/contractwatch.schema.json"`.

## Spec vs. reality

A spec can be correct on paper and still not describe the API that's running. `verify` replays recorded traffic
against the spec:

```bash
npx @wylan24/contractwatch verify api/openapi.yaml --har staging.har
```

```
contractwatch verify  api/openapi.yaml (v1.0.0) against staging.har
7 requests, 5 matched the spec · 2 of 4 operations exercised

Responses that break the spec (3)
  GET /pets
    ✖ 200 · required [].status is missing [missing-required]
    ✖ 200 · [].id is a string, but the spec says integer [type-mismatch]
  GET /pets/{id}
    ✖ 200 · status is "adopted", which isn't one of "available", "sold" [enum-mismatch]

Drift to document (3)
  GET /owners
    ! GET /owners isn't in the spec [undocumented-operation]
  GET /pets
    ! 200 · [].nickname isn't documented (×2) [undocumented-property] → document it as { type: [string, null] }
  GET /pets/{id}
    ! 500 · returned 500, which the spec doesn't list [undocumented-status]

Not exercised: POST /pets, DELETE /pets/{id}
```

Record the traffic however is easiest: **Save all as HAR** in browser devtools, Playwright's `recordHar`, an
end-to-end test run through mitmproxy or Charles, or your API gateway's logs exported as HAR. Requests are matched
to operations through the spec's `servers` base paths; pages, scripts and images in a browser recording are
skipped. `--fail-on error|warning|never` (default `error`), `--format`, `--markdown` and `--json` work as for `diff`.

| Finding | Severity | |
| --- | --- | --- |
| `type-mismatch` | error | A value has a type the schema doesn't allow (including `null`). |
| `missing-required` | error | A required property is missing. |
| `enum-mismatch` | error | A value isn't one of the allowed ones. |
| `unexpected-property` | error | A property appears in an object with `additionalProperties: false`. |
| `no-variant-matches` | error | A value matches none of the `oneOf`/`anyOf` variants. |
| `invalid-json` | error | A JSON response doesn't parse. |
| `undocumented-property` | warning | A property the schema doesn't mention, with a proposed schema from the values seen. |
| `undocumented-status` | warning | A status code the operation doesn't list (and no range or `default` covers). |
| `undocumented-media-type` | warning | A content type the response doesn't list. |
| `undocumented-operation` | warning | A JSON API call to a path and method the spec doesn't have. |
| `format-mismatch` | warning | A string that isn't a valid `date-time`, `date`, `uuid`, `email` or `uri`. |
| `constraint-violated` | warning | A value outside `minLength`/`maxLength`/`pattern`/`minimum`/`maximum`. |

## Direction matters

The same edit can be safe or breaking depending on who sends the data. Removing a property from a **response**
breaks clients that read it. Removing it from a **request** doesn't: old clients keep sending it, and the server
ignores it (unless the schema rejects extra properties, which contractwatch also checks). contractwatch compares
every schema with that in mind:

- **Request**: the new schema must still accept everything the old one accepted.
- **Response**: everything the new schema can return must still be something the old one allowed.

It also understands `allOf` (moving properties into a shared base isn't a change), `oneOf`/`anyOf` (variants are
matched by shape, not position), discriminators, callbacks and webhooks (sent by the server, so directions are
swapped), parameter serialization (`style`/`explode`), `servers` base paths, codes folded into a `4XX` or
`default` response, `readOnly`/`writeOnly`, OpenAPI 3.0 `nullable` vs. 3.1 type arrays, recursive
schemas, and renamed path parameters (`/pets/{id}` → `/pets/{petId}` is the same operation).

A change to a shared schema (a `components.schemas` entry, or a schema in another file reached by `$ref`) is
reported once, not once per endpoint that uses it. If `Pet` loses its `tag`
field and three operations return a `Pet`, the report has one line, `Pet.tag was removed`, listing the three
operations. It counts as one change, has one id to accept, and gives one code-scanning alert on the schema's line,
in whichever file defines it.
(The JSON report still lists every occurrence, each with its `component`.)

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


## Rules

| Rule | Meaning | In a request | In a response |
| --- | --- | --- | --- |
| `spec-version-changed` | OpenAPI version changed | info | info |
| `base-path-changed` | Server base path changed | breaking | breaking |
| `server-removed` | Server URL removed | warning | warning |
| `server-added` | Server URL added | info | info |
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
| `parameter-serialization-changed` | Parameter style or explode changed | breaking | breaking |
| `required-request-body-added` | Required request body added | breaking | breaking |
| `request-body-added` | Optional request body added | info | info |
| `request-body-removed` | Request body removed | warning | warning |
| `request-body-became-required` | Request body became required | breaking | breaking |
| `request-body-became-optional` | Request body became optional | info | info |
| `request-media-type-removed` | Request media type removed | breaking | breaking |
| `request-media-type-added` | Request media type added | info | info |
| `success-response-removed` | Success response removed | breaking | breaking |
| `response-now-covered` | Response folded into a range or default | info | info |
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
| `discriminator-property-changed` | Discriminator property changed | breaking | breaking |
| `discriminator-value-added` | Discriminator value added | info | warning |
| `discriminator-value-removed` | Discriminator value removed | breaking | info |
| `callback-removed` | Callback removed | warning | warning |
| `callback-added` | Callback added | info | info |
| `webhook-removed` | Webhook removed | warning | warning |
| `webhook-added` | Webhook added | info | info |
| `callback-media-type-removed` | Callback or webhook media type removed | breaking | breaking |

## Development

```bash
npm install
node src/cli.ts --help   # Node 22.18+ runs the TypeScript sources directly
npm test          # node --test
npm run typecheck
npm run build     # dist/ for the npm package
```

## License

MIT

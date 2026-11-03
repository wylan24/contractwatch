# contractwatch: plan

Catch breaking API changes before they ship. contractwatch compares two versions of an OpenAPI spec
(or, later, a spec against the real API's responses) and says which changes will break existing
clients. It runs on pull requests and leaves one comment: "this change will break clients, here's why."

It pairs with [mockgen](https://github.com/wylan24/mockgen): mock the API while it's being built, then
guard its contract once it's live.

## Who it's for

- **API owners**: a backend team changes `openapi.yaml` in a PR. They want a red check when a field is removed,
  and a quiet pass for additive changes.
- **API consumers**: a frontend or partner team vendors a provider's spec. They want to know what changed when
  they bump it.
- **Platform teams**: they want a policy ("no breaking changes without a major version bump") enforced across
  many repos, with an audit trail of accepted breaks.

## Core idea: direction matters

The same edit is safe in one direction and breaking in the other. Every schema comparison knows whether it
is looking at something the **client sends** (request) or something the **client reads** (response):

| Change                           | In a request          | In a response         |
| -------------------------------- | --------------------- | --------------------- |
| Property removed                 | warning               | **breaking**          |
| New required property            | **breaking**          | info                  |
| Property optional → required     | **breaking**          | info                  |
| Property required → optional     | info                  | **breaking**          |
| Enum value added                 | info                  | warning (unknown values) |
| Enum value removed               | **breaking**          | info                  |
| Type widened (integer → number)  | info                  | **breaking**          |
| Type narrowed / changed          | **breaking**          | **breaking**          |
| Becomes nullable                 | info                  | **breaking**          |
| Limits tightened (maxLength ↓…)  | **breaking**          | info                  |
| Limits loosened                  | info                  | warning               |

Operation-level rules: operation removed (breaking), new required parameter (breaking), parameter became
required (breaking), request body became required (breaking), success response or media type removed
(breaking), operation deprecated (warning), operation/parameter/response added (info).

Operations are matched by method + path with parameter names normalized, so renaming `{id}` to `{petId}`
is not a removal.

## Milestones

### M1: spec diff CLI (this commit)
- [x] Load OpenAPI 3.0/3.1 (YAML/JSON, multi-file `$ref`s); reject Swagger 2 with a clear message
- [x] Load the base spec from a git ref (`--base origin/main`), including relative `$ref` files at that ref
- [x] Direction-aware schema diff: properties, required, types, nullable, enums, formats, limits,
      arrays, `additionalProperties`, `allOf` merging, `oneOf`/`anyOf` variants, cycles
- [x] Operation diff: operations, parameters, request bodies, responses, media types, deprecation
- [x] Severity per rule: `breaking` / `warning` / `info`; `--fail-on` threshold; exit codes 0/1/2
- [x] Reporters: text (terminal), Markdown (PR comment / job summary), JSON, SARIF 2.1.0 with
      line numbers in the head spec and stable fingerprints
- [x] Tests on fixtures (`node --test`)

### M2: GitHub Action
- [x] Composite `action.yml`: diff the PR's spec against the base branch, job summary, sticky PR comment
      (updated in place, not re-posted), SARIF upload, outputs (`breaking`, `exit-code`)
- [x] Dogfood workflow (`.github/workflows/contract.yml`) runs the action on `examples/petstore.yaml` in PRs;
      verified on a real PR: fails on breaking changes, edits one comment in place, passes once fixed
- [ ] Self-contained CI job asserting the action's outputs (like dephealth's `action` job), so it runs without a PR
- [ ] Multiple specs per repo (`specs: api/*.yaml`)

### M3: accepting breaks on purpose
- [ ] `.contractwatch.json`: per-rule severity overrides, ignored paths, `x-` extensions to skip
- [ ] Accepted-break list keyed by change fingerprint, with a reason and an expiry
- [ ] "Breaking change requires a major version bump" policy (`info.version` semver check)
- [ ] `/contractwatch accept` PR comment command (later)

### M4: spec vs. reality (drift)
- [ ] `contractwatch verify spec.yaml --har traffic.har` / `--samples dir/`: validate real responses
      against the spec; report undocumented fields, type mismatches, undocumented status codes
- [ ] Reuse mockgen's schema inference to propose the spec patch that would match reality
- [ ] `contractwatch verify --url https://staging.example.com`: replay safe GET operations

### M5: product path
- [ ] Changelog generation ("what changed in v2.3 of our API") as Markdown for release notes
- [ ] Hosted history: spec versions per repo, breaking-change timeline, consumer notifications
- [ ] Org-wide policy and dashboards (paid tier)

## Non-goals for now
- Swagger 2.0 (convert first), GraphQL, gRPC/protobuf
- Linting style (naming conventions etc.): Spectral already does that

## Layout
```
src/
  cli.ts            argument parsing, exit codes
  load.ts           spec loading (file or git ref) → raw + dereferenced documents
  operations.ts     index operations, compare parameters / bodies / responses
  schema-diff.ts    direction-aware schema comparison
  rules.ts          rule catalog: id, severity per direction, description
  locate.ts         JSON pointer → file + line, following local $refs
  report/           text, markdown, json, sarif
test/               node --test suites + fixture specs
action.yml          GitHub Action
```

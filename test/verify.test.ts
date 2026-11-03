import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../src/config-schema.ts';
import { loadSpec } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import { proposedSchema, readHar, verify } from '../src/verify.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = path.join(root, 'test', 'fixtures');
const cli = path.join(root, 'src', 'cli.ts');
const tmp = mkdtempSync(path.join(tmpdir(), 'contractwatch-verify-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const run = (args: string[], cwd = root) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

describe('verify', async () => {
  const spec = await loadSpec(path.join(fixtures, 'petstore-base.yaml'));
  const result = verify(spec, readHar(path.join(fixtures, 'traffic.har')), 'traffic.har');
  const find = (rule: string) => result.findings.filter((f) => f.rule === rule);

  test('reports responses that break the spec', () => {
    assert.deepEqual(find('missing-required').map((f) => [f.operation, f.field]), [['GET /pets', '[].status']]);
    assert.deepEqual(find('type-mismatch').map((f) => [f.operation, f.field]), [['GET /pets', '[].id']]);
    assert.deepEqual(find('enum-mismatch').map((f) => [f.operation, f.field]), [['GET /pets/{id}', 'status']]);
    assert.ok(result.findings.filter((f) => f.severity === 'error').every((f) => ['missing-required', 'type-mismatch', 'enum-mismatch'].includes(f.rule)));
  });

  test('reports drift: undocumented fields (with a proposed schema), codes and operations', () => {
    const [nick] = find('undocumented-property');
    assert.equal(nick.field, '[].nickname');
    assert.equal(nick.count, 2);
    assert.equal(proposedSchema(nick.seenTypes!), '{ type: [string, null] }');
    assert.deepEqual(find('undocumented-status').map((f) => f.status), [500]);
    assert.deepEqual(find('undocumented-operation').map((f) => f.operation), ['GET /owners']);
  });

  test('ignores non-API requests and counts coverage', () => {
    assert.equal(result.requests, 7);
    assert.equal(result.matched, 5);
    assert.deepEqual(result.exercised.sort(), ['GET /pets', 'GET /pets/{id}']);
    assert.ok(!result.findings.some((f) => f.operation.includes('index.html')));
  });

  test('cli: exit 1 on mismatches, 0 with --fail-on never, 2 on a bad HAR', () => {
    const har = path.join(fixtures, 'traffic.har');
    const specFile = path.join(fixtures, 'petstore-base.yaml');
    assert.equal(run(['verify', specFile, '--har', har]).status, 1);
    assert.equal(run(['verify', specFile, '--har', har, '--fail-on', 'never']).status, 0);
    assert.match(run(['verify', specFile, '--har', har, '--format', 'markdown']).stdout, /### 🔴 The real API doesn't match/);
    writeFileSync(path.join(tmp, 'bad.har'), '{"log": {}}');
    const bad = run(['verify', specFile, '--har', path.join(tmp, 'bad.har')]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not a HAR file/);
  });
});

describe('validate', () => {
  const rules = (v: unknown, s: any) => validate(v, s).map((m) => `${m.rule}:${m.field}`);

  test('nullable, oneOf and closed objects', () => {
    assert.deepEqual(rules(null, { type: 'string', nullable: true }), []);
    assert.deepEqual(rules(null, { type: ['string', 'null'] }), []);
    assert.deepEqual(rules(null, { type: 'string' }), ['type-mismatch:']);
    const cat = { type: 'object', properties: { meow: { type: 'boolean' } }, required: ['meow'] };
    const dog = { type: 'object', properties: { bark: { type: 'boolean' } }, required: ['bark'] };
    assert.deepEqual(rules({ bark: true }, { oneOf: [cat, dog] }), []);
    assert.deepEqual(rules({ quack: true }, { oneOf: [cat, dog] }), ['no-variant-matches:']);
    assert.deepEqual(rules({ a: 1, b: 2 }, { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: false }), ['unexpected-property:b']);
  });

  test('formats and limits are drift, not errors', () => {
    const r = validate({ at: 'yesterday', n: 500 }, { type: 'object', properties: { at: { type: 'string', format: 'date-time' }, n: { type: 'integer', maximum: 100 } } });
    assert.deepEqual(r.map((m) => m.rule), ['format-mismatch', 'constraint-violated']);
  });

  test('integers satisfy number, not the other way round', () => {
    assert.deepEqual(rules(3, { type: 'number' }), []);
    assert.deepEqual(rules(3.5, { type: 'integer' }), ['type-mismatch:']);
  });
});

describe('accept command', () => {
  test('creates the config at the repository root and updates entries in place', () => {
    const repo = path.join(tmp, 'repo');
    spawnSync('git', ['init', '-q', repo]);
    const sub = path.join(repo, 'api');
    mkdirSync(sub);
    const a = run(['accept', '0123abcd', '89abcdef', '--reason', 'v2 migration', '--expires', '2027-01-31'], sub);
    assert.equal(a.status, 0, a.stderr);
    const file = path.join(repo, '.contractwatch.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).accept, [
      { id: '0123abcd', reason: 'v2 migration', expires: '2027-01-31' },
      { id: '89abcdef', reason: 'v2 migration', expires: '2027-01-31' },
    ]);
    const b = run(['accept', '0123abcd', '--reason', 'kept for v3'], sub);
    assert.match(b.stdout, /Updated 0123abcd/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).accept[0], { id: '0123abcd', reason: 'kept for v3' });
  });

  test('rejects bad input', () => {
    assert.match(run(['accept', 'nope', '--reason', 'r']).stderr, /isn't a change id/);
    assert.match(run(['accept', '0123abcd']).stderr, /--reason/);
    assert.match(run(['accept', '0123abcd', '--reason', 'r', '--expires', 'soon']).stderr, /YYYY-MM-DD/);
  });
});

test('schema/contractwatch.schema.json is up to date (npm run schema)', () => {
  const committed = JSON.parse(readFileSync(path.join(root, 'schema', 'contractwatch.schema.json'), 'utf8'));
  assert.deepEqual(committed, configSchema());
});

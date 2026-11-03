import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyConfig, compilePattern, type Config, ConfigError, loadConfig, majorBumped } from '../src/config.ts';
import { diffSpecs } from '../src/diff.ts';
import { loadSpec } from '../src/load.ts';
import type { DiffResult } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = path.join(root, 'test', 'fixtures');
const tmp = mkdtempSync(path.join(tmpdir(), 'contractwatch-config-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const petstore = async () => diffSpecs(await loadSpec(path.join(fixtures, 'petstore-base.yaml')), await loadSpec(path.join(fixtures, 'petstore-head.yaml')));
const breaking = (r: DiffResult) => r.changes.filter((c) => c.severity === 'breaking' && !c.accepted);

describe('change ids', () => {
  test('are 8 hex characters and stable across runs', async () => {
    const [a, b] = [await petstore(), await petstore()];
    assert.ok(a.changes.every((c) => /^[0-9a-f]{8}$/.test(c.id)));
    assert.deepEqual(a.changes.map((c) => c.id), b.changes.map((c) => c.id));
  });
});

describe('applyConfig', () => {
  test('accepting a change by id stops it failing, and says why', async () => {
    const result = await petstore();
    const removed = result.changes.find((c) => c.rule === 'operation-removed')!;
    const out = applyConfig(result, { accept: [{ id: removed.id, reason: 'DELETE moved to /v2' }] });
    const accepted = out.changes.find((c) => c.id === removed.id)!;
    assert.equal(accepted.accepted, 'DELETE moved to /v2');
    assert.equal(breaking(out).length, breaking(result).length - 1);
    assert.deepEqual(out.notes, []);
  });

  test('expired and stale acceptances are reported, not applied', async () => {
    const result = await petstore();
    const id = result.changes.find((c) => c.rule === 'operation-removed')!.id;
    const out = applyConfig(result, { accept: [{ id, reason: 'temporary', expires: '2026-01-01' }, { id: 'deadbeef', reason: 'old' }] }, '2026-11-03');
    assert.equal(out.changes.find((c) => c.id === id)!.accepted, undefined);
    assert.equal(out.notes.length, 2);
    assert.match(out.notes.join('\n'), /expired on 2026-01-01/);
    assert.match(out.notes.join('\n'), /deadbeef no longer occurs/);
  });

  test('rule overrides change severity or turn a rule off', async () => {
    const out = applyConfig(await petstore(), { rules: { 'enum-value-added': 'info', 'property-added': 'off' } });
    assert.ok(out.changes.filter((c) => c.rule === 'enum-value-added').every((c) => c.severity === 'info'));
    assert.ok(!out.changes.some((c) => c.rule === 'property-added'));
  });

  test('ignore patterns skip operations', async () => {
    const out = applyConfig(await petstore(), { ignore: ['/pets/*', 'POST /pets'] });
    assert.deepEqual([...new Set(out.changes.map((c) => c.operation))].sort(), ['GET /owners', 'GET /pets']);
  });

  test('a major version bump accepts breaking changes when allowed', async () => {
    const result = await petstore();
    const bumped = { ...result, head: { ...result.head, version: '2.0.0' } };
    assert.equal(breaking(applyConfig(bumped, { allowBreakingOnMajorBump: true })).length, 0);
    assert.equal(breaking(applyConfig(result, { allowBreakingOnMajorBump: true })).length, breaking(result).length);
    assert.match(applyConfig(bumped, { allowBreakingOnMajorBump: true }).changes[0].accepted ?? '', /version bumped from 1.0.0 to 2.0.0/);
  });
});

test('majorBumped treats the 0.x minor as major', () => {
  assert.ok(majorBumped('1.4.2', '2.0.0'));
  assert.ok(majorBumped('v1', 'v2'));
  assert.ok(majorBumped('0.2.9', '0.3.0'));
  assert.ok(!majorBumped('1.4.2', '1.5.0'));
  assert.ok(!majorBumped('2.0.0', '1.0.0'));
  assert.ok(!majorBumped('', '2.0.0'));
});

test('operation patterns', () => {
  const m = (p: string, op: string) => compilePattern(p)(op);
  assert.ok(m('/pets/*', 'GET /pets/{id}'));
  assert.ok(m('/pets/{petId}', 'DELETE /pets/{id}'));
  assert.ok(!m('/pets/*', 'GET /pets/{id}/photos'));
  assert.ok(m('/pets/**', 'GET /pets/{id}/photos'));
  assert.ok(m('get /pets', 'GET /pets'));
  assert.ok(!m('POST /pets', 'GET /pets'));
});

describe('loadConfig', () => {
  const write = (name: string, value: unknown) => {
    const f = path.join(tmp, name);
    writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
    return f;
  };
  const rejects = (value: unknown, pattern: RegExp) => assert.throws(() => loadConfig(write('bad.json', value)), (e: Error) => e instanceof ConfigError && pattern.test(e.message));

  test('accepts a full config', () => {
    const c: Config = { rules: { 'format-changed': 'off' }, ignore: ['/internal/**'], accept: [{ id: '0123abcd', reason: 'r', expires: '2027-01-01' }], allowBreakingOnMajorBump: true };
    assert.deepEqual(loadConfig(write('ok.json', c)), c);
  });

  test('explains mistakes', () => {
    rejects('{', /can't read it/);
    rejects({ rule: {} }, /unknown setting "rule"/);
    rejects({ rules: { 'enum-value-add': 'off' } }, /did you mean "enum-value-added"/);
    rejects({ rules: { 'format-changed': 'error' } }, /must be one of/);
    rejects({ accept: [{ id: 'xyz', reason: 'r' }] }, /8-character change id/);
    rejects({ accept: [{ id: '0123abcd' }] }, /needs a "reason"/);
    rejects({ accept: [{ id: '0123abcd', reason: 'r', expires: 'next week' }] }, /YYYY-MM-DD/);
  });
});

test('cli picks up .contractwatch.json from the working directory', () => {
  const cli = path.join(root, 'src', 'cli.ts');
  const dir = path.join(tmp, 'project');
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'diff', path.join(fixtures, 'multi-base', 'openapi.yaml'), path.join(fixtures, 'multi-head', 'openapi.yaml'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  rmSync(dir, { recursive: true, force: true });
  spawnSync('git', ['init', '-q', dir]);
  const json = JSON.parse(run('--format', 'json').stdout);
  assert.equal(json.summary.breaking, 2);

  writeFileSync(path.join(dir, '.contractwatch.json'), JSON.stringify({ accept: json.changes.map((c: any) => ({ id: c.id, reason: 'email is optional now' })) }));
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /Accepted \(2\)/);
  assert.equal(run('--no-config').status, 1);

  writeFileSync(path.join(dir, '.contractwatch.json'), '{"rules": {"nope": "off"}}');
  const bad = run();
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown rule "nope"/);
});

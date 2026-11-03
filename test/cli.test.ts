import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Locator } from '../src/locate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'src', 'cli.ts');
const fixtures = path.join(root, 'test', 'fixtures');
const tmp = mkdtempSync(path.join(tmpdir(), 'contractwatch-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], cwd = root) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('cli', () => {
  const base = path.join(fixtures, 'petstore-base.yaml');
  const head = path.join(fixtures, 'petstore-head.yaml');

  test('exit 1 on breaking changes, 0 with --fail-on never', () => {
    assert.equal(run(['diff', base, head]).code, 1);
    assert.equal(run(['diff', base, head, '--fail-on', 'never']).code, 0);
    assert.equal(run(['diff', base, base]).code, 0);
  });

  test('exit 2 on bad input', () => {
    const r = run(['diff', base, path.join(fixtures, 'missing.yaml')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no such file/);
    const swagger = path.join(tmp, 'swagger.yaml');
    writeFileSync(swagger, 'swagger: "2.0"\ninfo: {title: x, version: "1"}\npaths: {}\n');
    assert.match(run(['diff', swagger, base]).stderr, /Swagger 2.0 is not supported/);
    assert.equal(run(['frobnicate']).code, 2);
  });

  test('writes markdown, json and sarif reports', () => {
    const md = path.join(tmp, 'r.md');
    const json = path.join(tmp, 'r.json');
    const sarif = path.join(tmp, 'r.sarif');
    run(['diff', base, head, '--markdown', md, '--json', json, '--sarif', sarif]);

    const markdown = readFileSync(md, 'utf8');
    assert.match(markdown, /^<!-- contractwatch -->/);
    // Pet's four breaking changes count once each, not once per operation that returns a Pet.
    assert.match(markdown, /### 🔴 13 breaking changes/);
    assert.match(markdown, /🔴 13 breaking · 🟡 3 warnings · 🟢 3 non-breaking/);
    assert.match(markdown, /\| `GET \/pets`, `POST \/pets`, `GET \/pets\/\{petId\}` \| schema `Pet` \| `Pet.tag` was removed/);
    assert.match(markdown, /\| `DELETE \/pets\/\{id\}` \|/);

    const report = JSON.parse(readFileSync(json, 'utf8'));
    assert.equal(report.summary.breaking, 13);
    // JSON keeps every occurrence; the three Pet.tag removals share one id.
    assert.equal(report.changes.filter((c: any) => c.componentMessage === '`Pet.tag` was removed').length, 3);
    assert.equal(new Set(report.changes.filter((c: any) => c.component === 'Pet').map((c: any) => c.id)).size, 6);

    const s = JSON.parse(readFileSync(sarif, 'utf8'));
    const results = s.runs[0].results;
    assert.equal(results.length, 13 + 3 + 3);
    const removed = results.find((r: any) => r.ruleId === 'property-removed');
    // `tag` was removed from the Pet component; the closest surviving line is Pet's `properties:`.
    const headLines = readFileSync(head, 'utf8').split('\n');
    assert.match(headLines[removed.locations[0].physicalLocation.region.startLine - 1], /properties:/);
    assert.ok(results.every((r: any) => r.partialFingerprints.contractwatch.length === 32));
  });
});

test('locator follows local $refs to the component that defines a field', () => {
  const text = readFileSync(path.join(fixtures, 'petstore-head.yaml'), 'utf8');
  const lines = text.split('\n');
  const line = new Locator(text).line(['paths', '/pets/{petId}', 'get', 'responses', '200', 'content', 'application/json', 'schema', 'properties', 'birthday']);
  assert.match(lines[line - 1], /^\s+birthday:/);
});

describe('--base <git-ref>', () => {
  const repo = path.join(tmp, 'repo');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const write = (f: string, s: string) => writeFileSync(path.join(repo, f), s);

  test('compares a multi-file spec with itself at a ref', () => {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'core.autocrlf', 'false');
    write('api.yaml', readFileSync(path.join(fixtures, 'multi-base', 'openapi.yaml'), 'utf8'));
    mkdirSync(path.join(repo, 'schemas'));
    write('schemas/user.yaml', readFileSync(path.join(fixtures, 'multi-base', 'schemas', 'user.yaml'), 'utf8'));
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    // Change only the referenced file: the diff must read it at the ref, not from disk.
    write('schemas/user.yaml', readFileSync(path.join(fixtures, 'multi-head', 'schemas', 'user.yaml'), 'utf8'));

    const r = run(['diff', 'api.yaml', '--base', 'HEAD', '--format', 'json'], repo);
    assert.equal(r.code, 1, r.stderr);
    const rules = JSON.parse(r.stdout).changes.map((c: any) => c.rule).sort();
    assert.deepEqual(rules, ['became-nullable', 'property-became-optional']);
  });

  test('a spec that is new since the ref passes', () => {
    write('new.yaml', 'openapi: 3.1.0\ninfo: {title: n, version: "1"}\npaths: {}\n');
    const r = run(['diff', 'new.yaml', '--base', 'HEAD'], repo);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /new since HEAD/);
  });
});

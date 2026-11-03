import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RULES } from './rules.ts';
import type { DiffResult, Severity } from './types.ts';

/**
 * `.contractwatch.json`: how a team tunes the check and records breaking changes it makes on purpose.
 *
 *   {
 *     "rules": { "enum-value-added": "info", "parameter-removed": "off" },
 *     "ignore": ["/internal/**", "DELETE /admin/*"],
 *     "accept": [{ "id": "3fa2c1d0", "reason": "v2 migration, clients notified", "expires": "2027-01-31" }],
 *     "allowBreakingOnMajorBump": true
 *   }
 */
export interface Config {
  rules?: Record<string, Severity | 'off'>;
  /** Operations to skip: `/path/*` (one segment), `/path/**` (any depth), optionally prefixed by a method. */
  ignore?: string[];
  accept?: Acceptance[];
  /** Breaking changes don't fail the check when `info.version` gets a new major (or 0.x minor) version. */
  allowBreakingOnMajorBump?: boolean;
}

export interface Acceptance {
  id: string;
  reason: string;
  /** `YYYY-MM-DD`; after this date the acceptance no longer applies. */
  expires?: string;
}

export const CONFIG_FILE = '.contractwatch.json';

export class ConfigError extends Error {
  readonly file: string;

  constructor(message: string, file: string) {
    super(`${file}: ${message}`);
    this.name = 'ConfigError';
    this.file = file;
  }
}

/** The first `.contractwatch.json` in `dir` or its parents, stopping at the repository root. */
export function findConfig(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const f = path.join(d, CONFIG_FILE);
    if (existsSync(f)) return f;
    if (existsSync(path.join(d, '.git')) || path.dirname(d) === d) return undefined;
  }
}

/** Where a new config file goes: next to the existing one, else at the repository root, else in `dir`. */
export function configPathFor(dir: string): string {
  const existing = findConfig(dir);
  if (existing) return existing;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, '.git'))) return path.join(d, CONFIG_FILE);
    if (path.dirname(d) === d) return path.join(path.resolve(dir), CONFIG_FILE);
  }
}

/**
 * Add acceptances to a config file, creating it if needed. An id that is already accepted gets the new
 * reason and expiry. Other settings are kept as they are.
 */
export function addAcceptances(file: string, entries: Acceptance[]): { added: string[]; updated: string[] } {
  const config: Config = existsSync(file) ? loadConfig(file) : {};
  const accept = [...(config.accept ?? [])];
  const added: string[] = [];
  const updated: string[] = [];
  for (const e of entries) {
    const i = accept.findIndex((a) => a.id === e.id);
    if (i === -1) {
      accept.push(e);
      added.push(e.id);
    } else {
      accept[i] = e;
      updated.push(e.id);
    }
  }
  const next = { ...config, accept };
  validate(next, path.basename(file));
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return { added, updated };
}

export function loadConfig(file: string): Config {
  const shown = path.relative(process.cwd(), file).split(path.sep).join('/') || file;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`can't read it: ${(err as Error).message}`, shown);
  }
  return validate(raw, shown);
}

const SEVERITY_VALUES = ['breaking', 'warning', 'info', 'off'];

function validate(raw: unknown, file: string): Config {
  const fail = (msg: string): never => {
    throw new ConfigError(msg, file);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected a JSON object');
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!['$schema', 'rules', 'ignore', 'accept', 'allowBreakingOnMajorBump'].includes(key)) fail(`unknown setting "${key}"`);
  }
  if (c.rules !== undefined) {
    if (!c.rules || typeof c.rules !== 'object' || Array.isArray(c.rules)) fail('"rules" must be an object of rule → severity');
    for (const [rule, sev] of Object.entries(c.rules as object)) {
      if (!(rule in RULES)) fail(`unknown rule "${rule}" in "rules"${suggest(rule)}`);
      if (!SEVERITY_VALUES.includes(sev)) fail(`rule "${rule}" must be one of ${SEVERITY_VALUES.join(', ')}`);
    }
  }
  if (c.ignore !== undefined && (!Array.isArray(c.ignore) || !c.ignore.every((p) => typeof p === 'string'))) fail('"ignore" must be a list of operation patterns');
  if (c.accept !== undefined) {
    if (!Array.isArray(c.accept)) fail('"accept" must be a list');
    (c.accept as unknown[]).forEach((a, i) => {
      const e = a as Record<string, unknown>;
      if (!e || typeof e !== 'object') fail(`accept[${i}] must be an object`);
      if (typeof e.id !== 'string' || !/^[0-9a-f]{8}$/.test(e.id)) fail(`accept[${i}].id must be an 8-character change id, as shown in the report`);
      if (typeof e.reason !== 'string' || !e.reason.trim()) fail(`accept[${i}] needs a "reason"`);
      if (e.expires !== undefined && (typeof e.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires))) fail(`accept[${i}].expires must be a YYYY-MM-DD date`);
    });
  }
  if (c.allowBreakingOnMajorBump !== undefined && typeof c.allowBreakingOnMajorBump !== 'boolean') fail('"allowBreakingOnMajorBump" must be true or false');
  return c as Config;
}

function suggest(rule: string): string {
  const close = Object.keys(RULES).find((r) => r.includes(rule) || rule.includes(r));
  return close ? ` (did you mean "${close}"?)` : '';
}

/** Apply a config to a diff: drop ignored and disabled changes, re-grade severities, mark accepted ones. */
export function applyConfig(result: DiffResult, config: Config, today = new Date().toISOString().slice(0, 10)): DiffResult {
  const ignore = (config.ignore ?? []).map(compilePattern);
  const changes = [];
  for (const ch of result.changes) {
    if (ch.operation && ignore.some((m) => m(ch.operation!))) continue;
    const override = config.rules?.[ch.rule];
    if (override === 'off') continue;
    changes.push(override ? { ...ch, severity: override } : { ...ch });
  }

  const notes = [...result.notes];
  const ids = new Set(changes.map((c) => c.id));
  for (const a of config.accept ?? []) {
    if (!ids.has(a.id)) {
      notes.push(`Accepted change ${a.id} no longer occurs; its entry can be removed.`);
      continue;
    }
    if (a.expires && a.expires < today) {
      notes.push(`Acceptance of ${a.id} expired on ${a.expires} ("${a.reason}").`);
      continue;
    }
    for (const c of changes) if (c.id === a.id) c.accepted = a.reason;
  }

  if (config.allowBreakingOnMajorBump && majorBumped(result.base.version, result.head.version)) {
    for (const c of changes) if (c.severity === 'breaking' && !c.accepted) c.accepted = `version bumped from ${result.base.version} to ${result.head.version}`;
  }

  return { ...result, changes, notes };
}

/** `2.0.0` after `1.4.2`, or `0.3.0` after `0.2.9` (in 0.x, the minor version is the breaking one). */
export function majorBumped(from: string, to: string): boolean {
  const parse = (v: string) => /^v?(\d+)(?:\.(\d+))?/.exec(v.trim())?.slice(1).map((n) => Number(n ?? 0));
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return false;
  if (b[0] !== a[0]) return b[0] > a[0];
  return a[0] === 0 && b[1] > a[1];
}

/** `GET /pets/*` or `/internal/**`. Path parameter names don't matter: `{id}` matches `{petId}`. */
export function compilePattern(pattern: string): (operation: string) => boolean {
  const m = /^\s*(?:([A-Za-z*]+)\s+)?(\S+)\s*$/.exec(pattern);
  if (!m) return () => false;
  const method = m[1]?.toUpperCase();
  const norm = (p: string) => p.replace(/\{[^}]*\}/g, '{}').replace(/(.)\/+$/, '$1');
  const source = norm(m[2])
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const re = new RegExp(`^${source}$`);
  return (operation) => {
    const [opMethod, opPath] = operation.split(' ', 2);
    return (!method || method === '*' || method === opMethod) && re.test(norm(opPath));
  };
}

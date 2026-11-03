import { readFileSync } from 'node:fs';
import type { Spec } from './types.ts';
import { DRIFT_SEVERITY, type DriftRule, jsonType, validate } from './validate.ts';

/**
 * Spec vs. reality: replay recorded traffic (a HAR file, as browsers, Playwright and most proxies save it)
 * against the spec and report where the API's real responses differ from what the spec promises.
 */

export type VerifyRule = DriftRule | 'undocumented-operation' | 'undocumented-status' | 'undocumented-media-type' | 'invalid-json';

export interface Finding {
  rule: VerifyRule;
  severity: 'error' | 'warning';
  /** `GET /pets/{id}`, or the raw `GET /path` for undocumented operations. */
  operation: string;
  status?: number;
  field?: string;
  message: string;
  /** How many recorded responses showed this. */
  count: number;
  example?: unknown;
  /** For undocumented properties: the JSON types seen, to propose a schema. */
  seenTypes?: string[];
}

export interface VerifyResult {
  spec: Pick<Spec, 'file' | 'title' | 'version'>;
  traffic: string;
  /** Requests in the file, and how many matched an operation in the spec. */
  requests: number;
  matched: number;
  /** Operations in the spec, and which of them the traffic exercised. */
  operations: string[];
  exercised: string[];
  findings: Finding[];
}

export class TrafficError extends Error {}

interface HarEntry {
  request: { method: string; url: string };
  response: { status: number; content?: { mimeType?: string; text?: string; encoding?: string } };
}

export function readHar(file: string): HarEntry[] {
  let har: any;
  try {
    har = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new TrafficError(`${file}: can't read it as a HAR file: ${(err as Error).message}`);
  }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new TrafficError(`${file}: not a HAR file (no log.entries)`);
  return entries.filter((e: any) => typeof e?.request?.method === 'string' && typeof e?.request?.url === 'string' && typeof e?.response?.status === 'number');
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  params: number;
  op: any;
}

function routesOf(doc: any): Route[] {
  const routes: Route[] = [];
  for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    const source = p.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+');
    for (const m of METHODS) {
      if (item[m]) routes.push({ method: m.toUpperCase(), path: p, pattern: new RegExp(`^${source}/?$`), params: (p.match(/\{/g) ?? []).length, op: item[m] });
    }
  }
  // Literal paths win over templated ones: `/pets/mine` before `/pets/{id}`.
  return routes.sort((a, b) => a.params - b.params);
}

/** Path prefixes from `servers` (`https://api.example.com/v1` → `/v1`), longest first. */
function basePaths(doc: any): string[] {
  const out = new Set<string>(['']);
  for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
    if (typeof s?.url !== 'string') continue;
    const url = s.url.replace(/\{([^}]+)\}/g, (_: string, v: string) => String(s.variables?.[v]?.default ?? ''));
    try {
      out.add(new URL(url, 'http://relative.invalid').pathname.replace(/\/+$/, ''));
    } catch {}
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const isJson = (mime = '') => /^application\/(.+\+)?json\b|\/json\b/i.test(mime);
const mediaKey = (t: string) => t.split(';')[0].trim().toLowerCase();

export function verify(spec: Spec, entries: HarEntry[], traffic: string): VerifyResult {
  const routes = routesOf(spec.doc);
  const bases = basePaths(spec.doc);
  const findings = new Map<string, Finding>();
  const add = (f: Omit<Finding, 'count' | 'severity'> & { severity?: Finding['severity'] }, value?: unknown) => {
    const key = [f.rule, f.operation, f.status ?? '', f.field ?? '', f.field ? '' : f.message].join('\0');
    const existing = findings.get(key);
    if (existing) {
      existing.count++;
      if (existing.seenTypes && !existing.seenTypes.includes(jsonType(value))) existing.seenTypes.push(jsonType(value));
      return;
    }
    const severity = f.severity ?? (f.rule in DRIFT_SEVERITY ? DRIFT_SEVERITY[f.rule as DriftRule] : 'warning');
    findings.set(key, { ...f, severity, count: 1, ...(f.rule === 'undocumented-property' ? { seenTypes: [jsonType(value)] } : {}) });
  };

  let matched = 0;
  const exercised = new Set<string>();
  for (const e of entries) {
    const method = e.request.method.toUpperCase();
    let pathname: string;
    try {
      pathname = new URL(e.request.url, 'http://relative.invalid').pathname;
    } catch {
      continue;
    }
    const candidates = bases.filter((b) => pathname === b || pathname.startsWith(`${b}/`)).map((b) => pathname.slice(b.length) || '/');
    const route = routes.find((r) => r.method === method && candidates.some((c) => r.pattern.test(c)));
    const mime = e.response.content?.mimeType ?? '';

    if (!route) {
      // Pages, scripts and images in a browser recording aren't API calls; only JSON responses count.
      if (candidates.length && isJson(mime)) add({ rule: 'undocumented-operation', operation: `${method} ${candidates[candidates.length - 1]}`, message: `${method} ${pathname} isn't in the spec` });
      continue;
    }
    matched++;
    const label = `${route.method} ${route.path}`;
    exercised.add(label);
    const status = e.response.status;
    const responses = route.op.responses ?? {};
    const key = [String(status), `${String(status)[0]}XX`, `${String(status)[0]}xx`, 'default'].find((k) => k in responses);
    if (!key) {
      add({ rule: 'undocumented-status', operation: label, status, message: `returned ${status}, which the spec doesn't list` });
      continue;
    }
    const content: Record<string, any> = responses[key]?.content ?? {};
    if (!Object.keys(content).length || !e.response.content?.text) continue;
    const media = Object.entries(content).find(([t]) => mediaKey(t) === mediaKey(mime)) ?? (isJson(mime) ? Object.entries(content).find(([t]) => isJson(t)) : undefined);
    if (!media) {
      add({ rule: 'undocumented-media-type', operation: label, status, message: `returned ${mediaKey(mime) || 'no content type'}, which the ${key} response doesn't list` });
      continue;
    }
    if (!isJson(mime) || !media[1]?.schema) continue;

    let body: unknown;
    try {
      const text = e.response.content.encoding === 'base64' ? Buffer.from(e.response.content.text, 'base64').toString('utf8') : e.response.content.text;
      body = JSON.parse(text);
    } catch {
      add({ rule: 'invalid-json', severity: 'error', operation: label, status, message: `returned a body that isn't valid JSON` });
      continue;
    }
    for (const m of validate(body, media[1].schema)) add({ rule: m.rule, operation: label, status, field: m.field, message: m.message, example: m.value }, m.value);
  }

  const order = { error: 0, warning: 1 };
  return {
    spec: { file: spec.file, title: spec.title, version: spec.version },
    traffic,
    requests: entries.length,
    matched,
    operations: routes.map((r) => `${r.method} ${r.path}`),
    exercised: [...exercised],
    findings: [...findings.values()].sort((a, b) => order[a.severity] - order[b.severity] || a.operation.localeCompare(b.operation)),
  };
}

/** The schema a field should get, from the types its values had: `{ type: string }`, `{ type: [integer, "null"] }`. */
export function proposedSchema(types: string[]): string {
  const t = [...new Set(types)].sort((a, b) => (a === 'null' ? 1 : b === 'null' ? -1 : a.localeCompare(b)));
  return t.length === 1 ? `{ type: ${t[0]} }` : `{ type: [${t.join(', ')}] }`;
}

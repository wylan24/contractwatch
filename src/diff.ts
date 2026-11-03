import { type RuleId, severityOf } from './rules.ts';
import { type ComponentNames, diffSchema } from './schema-diff.ts';
import { createHash } from 'node:crypto';
import type { Change, DiffResult, Direction, RawChange, Schema, Spec } from './types.ts';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

interface Operation {
  method: string;
  /** Path as written in the spec. */
  path: string;
  op: any;
  pathItem: any;
}

/** Compare two loaded specs. Changes come back ordered: document-level first, then by operation. */
export function diffSpecs(base: Spec, head: Spec): DiffResult {
  const out: RawChange[] = [];
  const pick = (s: Spec) => ({ file: s.file, source: s.source, title: s.title, version: s.version, openapi: s.openapi });

  if (base.openapi.slice(0, 3) !== head.openapi.slice(0, 3)) {
    out.push(change('spec-version-changed', `OpenAPI version changed from ${base.openapi} to ${head.openapi}`, ['openapi']));
  }

  const names: Names = { base: base.names ?? new Map(), head: head.names ?? new Map() };
  const b = indexOperations(base.doc);
  const h = indexOperations(head.doc);
  for (const [key, bo] of b) {
    const ho = h.get(key);
    const label = `${bo.method} ${(ho ?? bo).path}`;
    if (!ho) {
      out.push(change('operation-removed', `${label} was removed`, ['paths', bo.path, bo.method.toLowerCase()], label));
      continue;
    }
    diffOperation(base.doc, head.doc, bo, ho, label, out, names);
  }
  for (const [key, ho] of h) {
    if (b.has(key)) continue;
    const label = `${ho.method} ${ho.path}`;
    out.push(change('operation-added', `${label} was added`, ['paths', ho.path, ho.method.toLowerCase()], label));
  }

  return { base: pick(base), head: pick(head), changes: out.map((c) => ({ id: changeId(c), ...c })), notes: [] };
}

/**
 * Hash of what changed and where, without line numbers or the spec's file name, so an id stays the same
 * across unrelated edits and branches. Eight hex characters are plenty within one spec.
 */
export function changeId(c: RawChange): string {
  // A change inside a shared schema is one change wherever the schema is used, so it gets one id.
  const parts = c.component ? ['component', c.rule, c.direction ?? '', c.component, c.componentMessage ?? ''] : [c.rule, c.operation ?? '', c.where ?? '', c.message];
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 8);
}

function change(rule: RuleId, message: string, pointer: string[], operation?: string, direction?: Direction, where?: string): RawChange {
  return { rule, severity: severityOf(rule, direction), operation, direction, where, message, pointer };
}

/** Operations keyed by method + path with parameter names blanked, so `{id}` → `{petId}` still matches. */
function indexOperations(doc: any): Map<string, Operation> {
  const out = new Map<string, Operation>();
  for (const [p, pathItem] of Object.entries<any>(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const norm = p.replace(/\{[^}]*\}/g, '{}').replace(/(.)\/+$/, '$1');
    for (const m of METHODS) {
      if (pathItem[m]) out.set(`${m.toUpperCase()} ${norm}`, { method: m.toUpperCase(), path: p, op: pathItem[m], pathItem });
    }
  }
  return out;
}

type Names = { base: ComponentNames; head: ComponentNames };

function diffOperation(baseDoc: any, headDoc: any, bo: Operation, ho: Operation, label: string, out: RawChange[], names: Names) {
  const at = ['paths', ho.path, ho.method.toLowerCase()];
  const push = (rule: RuleId, message: string, pointer: string[] = at, direction?: Direction, where?: string) =>
    out.push(change(rule, message, pointer, label, direction, where));

  if (!bo.op.deprecated && ho.op.deprecated) push('operation-deprecated', `${label} is deprecated`, [...at, 'deprecated']);
  if (bo.op.deprecated && !ho.op.deprecated) push('operation-undeprecated', `${label} is no longer deprecated`);

  const bs = securityOf(baseDoc, bo.op);
  const hs = securityOf(headDoc, ho.op);
  if (bs !== hs) {
    if (bs === '') push('security-added', `${label} now requires authentication (${hs})`, [...at, 'security']);
    else if (hs === '') push('security-removed', `${label} no longer requires authentication`);
    else push('security-changed', `${label} security changed from ${bs} to ${hs}`, [...at, 'security']);
  }

  diffParameters(bo, ho, label, at, out, names);
  diffRequestBody(bo.op.requestBody, ho.op.requestBody, label, at, out, names);
  diffResponses(bo.op.responses ?? {}, ho.op.responses ?? {}, label, at, out, names);
}

/**
 * Effective security as a comparable string: alternatives joined by ` or `, schemes within one by ` and `.
 * An empty requirement (`{}`) makes auth optional, which counts as none.
 */
function securityOf(doc: any, op: any): string {
  const reqs: unknown = op.security ?? doc.security;
  if (!Array.isArray(reqs) || reqs.length === 0) return '';
  const alts = reqs.map((r) => Object.keys(r ?? {}).sort().join(' and '));
  if (alts.includes('')) return '';
  return [...new Set(alts)].sort().join(' or ');
}

interface Param {
  name: string;
  in: string;
  required: boolean;
  deprecated: boolean;
  schema?: Schema;
  /** Index among the operation's parameters as written, for pointers. */
  index: number;
  /** Whether it was declared on the path item rather than the operation. */
  pathLevel: boolean;
}

function parametersOf(o: Operation): Map<string, Param> {
  const byKey = new Map<string, Param>();
  const pathOrder = [...o.path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  for (const [list, pathLevel] of [
    [o.pathItem.parameters, true],
    [o.op.parameters, false],
  ] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((p: any, index: number) => {
      if (!p || typeof p.name !== 'string') return;
      // Path parameters are matched by position, so renaming one isn't a change.
      const pos = pathOrder.indexOf(p.name);
      const key = p.in === 'path' && pos !== -1 ? `path:#${pos}` : `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`;
      const schema = p.schema ?? (Object.values<any>(p.content ?? {})[0]?.schema as Schema | undefined);
      byKey.set(key, { name: p.name, in: p.in, required: p.in === 'path' || !!p.required, deprecated: !!p.deprecated, schema, index, pathLevel });
    });
  }
  return byKey;
}

function diffParameters(bo: Operation, ho: Operation, label: string, at: string[], out: RawChange[], names: Names) {
  const bp = parametersOf(bo);
  const hp = parametersOf(ho);
  const ptr = (p: Param) => (p.pathLevel ? ['paths', ho.path, 'parameters', String(p.index)] : [...at, 'parameters', String(p.index)]);
  const push = (rule: RuleId, message: string, pointer: string[], where?: string, direction?: Direction) =>
    out.push(change(rule, message, pointer, label, direction, where));
  const desc = (p: Param) => `${p.in} parameter \`${p.name}\``;

  for (const [key, p] of bp) {
    if (!hp.has(key)) push('parameter-removed', `${desc(p)} was removed`, [...at, 'parameters'], desc(p));
  }
  for (const [key, p] of hp) {
    const old = bp.get(key);
    if (!old) {
      if (p.required) push('required-parameter-added', `new required ${desc(p)}`, ptr(p), desc(p));
      else push('parameter-added', `new optional ${desc(p)}`, ptr(p), desc(p));
      continue;
    }
    if (!old.required && p.required) push('parameter-became-required', `${desc(p)} is now required`, ptr(p), desc(p));
    if (old.required && !p.required) push('parameter-became-optional', `${desc(p)} is now optional`, ptr(p), desc(p));
    if (!old.deprecated && p.deprecated) push('parameter-deprecated', `${desc(p)} is deprecated`, ptr(p), desc(p));
    diffSchema(old.schema, p.schema, [...ptr(p), 'schema'], { operation: label, direction: 'request', label: desc(p), out, names });
  }
}

const mediaKey = (t: string) => t.split(';')[0].trim().toLowerCase();

function contentOf(container: any): Map<string, { type: string; schema?: Schema }> {
  const out = new Map<string, { type: string; schema?: Schema }>();
  for (const [type, media] of Object.entries<any>(container?.content ?? {})) out.set(mediaKey(type), { type, schema: media?.schema });
  return out;
}

function diffRequestBody(b: any, h: any, label: string, at: string[], out: RawChange[], names: Names) {
  const ptr = [...at, 'requestBody'];
  const push = (rule: RuleId, message: string, pointer = ptr) => out.push(change(rule, message, pointer, label, 'request', 'request body'));
  if (!b && !h) return;
  if (!b) return push(h.required ? 'required-request-body-added' : 'request-body-added', `a ${h.required ? 'required' : 'optional'} request body was added`);
  if (!h) return push('request-body-removed', 'the request body was removed');
  if (!b.required && h.required) push('request-body-became-required', 'the request body is now required');
  if (b.required && !h.required) push('request-body-became-optional', 'the request body is now optional');

  const bc = contentOf(b);
  const hc = contentOf(h);
  for (const [k, m] of bc) if (!hc.has(k)) push('request-media-type-removed', `request body no longer accepts ${m.type}`, [...ptr, 'content']);
  for (const [k, m] of hc) {
    const old = bc.get(k);
    if (!old) {
      push('request-media-type-added', `request body now also accepts ${m.type}`, [...ptr, 'content', m.type]);
      continue;
    }
    const where = bc.size > 1 ? `request body (${m.type})` : 'request body';
    diffSchema(old.schema, m.schema, [...ptr, 'content', m.type, 'schema'], { operation: label, direction: 'request', label: where, out, names });
  }
}

function diffResponses(b: Record<string, any>, h: Record<string, any>, label: string, at: string[], out: RawChange[], names: Names) {
  const ptr = [...at, 'responses'];
  const push = (rule: RuleId, message: string, pointer: string[], where: string) => out.push(change(rule, message, pointer, label, 'response', where));
  const success = (code: string) => /^[23]/.test(code);

  for (const code of Object.keys(b)) {
    if (code in h) continue;
    if (success(code)) push('success-response-removed', `the ${code} response was removed`, ptr, `response ${code}`);
    else push('error-response-removed', `the ${code} response was removed`, ptr, `response ${code}`);
  }
  for (const [code, hr] of Object.entries<any>(h)) {
    const br = b[code];
    const rptr = [...ptr, code];
    const where = `response ${code}`;
    if (!br) {
      push('response-added', `new ${code} response`, rptr, where);
      continue;
    }

    const bc = contentOf(br);
    const hc = contentOf(hr);
    for (const [k, m] of bc) if (!hc.has(k)) push('response-media-type-removed', `the ${code} response no longer returns ${m.type}`, [...rptr, 'content'], where);
    for (const [k, m] of hc) {
      const old = bc.get(k);
      if (!old) {
        push('response-media-type-added', `the ${code} response can now also return ${m.type}`, [...rptr, 'content', m.type], where);
        continue;
      }
      const label2 = `${where} body${bc.size > 1 ? ` (${m.type})` : ''}`;
      diffSchema(old.schema, m.schema, [...rptr, 'content', m.type, 'schema'], { operation: label, direction: 'response', label: label2, out, names });
    }

    const bh = headersOf(br);
    const hh = headersOf(hr);
    for (const [k, hd] of bh) {
      if (hh.has(k)) continue;
      const rule = hd.def?.required ? 'required-response-header-removed' : 'response-header-removed';
      push(rule, `the ${code} response no longer sends header \`${hd.name}\``, [...rptr, 'headers'], where);
    }
    for (const [k, hd] of hh) {
      const old = bh.get(k);
      const hptr = [...rptr, 'headers', hd.name];
      if (!old) push('response-header-added', `the ${code} response now sends header \`${hd.name}\``, hptr, where);
      else diffSchema(old.def?.schema, hd.def?.schema, [...hptr, 'schema'], { operation: label, direction: 'response', label: `${where} header \`${hd.name}\``, out, names });
    }
  }
}

function headersOf(res: any): Map<string, { name: string; def: any }> {
  const out = new Map<string, { name: string; def: any }>();
  for (const [name, def] of Object.entries<any>(res?.headers ?? {})) out.set(name.toLowerCase(), { name, def });
  return out;
}

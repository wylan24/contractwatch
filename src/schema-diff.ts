import { type RuleId, severityOf } from './rules.ts';
import type { Direction, RawChange, Schema } from './types.ts';

/**
 * Direction-aware schema comparison. For a request, the head schema must still accept everything the
 * base schema accepted (old clients keep sending old payloads). For a response, everything the head
 * schema can produce must still be something the base schema allowed (old clients keep parsing).
 */

export interface SchemaContext {
  operation: string;
  direction: Direction;
  /** Prefix for `where`, e.g. `response 200 body`. */
  label: string;
  out: RawChange[];
}

export function diffSchema(base: Schema | undefined, head: Schema | undefined, pointer: string[], ctx: SchemaContext): void {
  walk(base, head, pointer, '', ctx, new Map());
}

type Seen = Map<Schema, Set<Schema>>;

const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
type Type = (typeof TYPES)[number];

function walk(baseIn: Schema | undefined, headIn: Schema | undefined, pointer: string[], field: string, ctx: SchemaContext, seen: Seen): void {
  if (!isSchema(baseIn) || !isSchema(headIn)) return;
  // Cycles (and shared components) are compared once per pair.
  let pairs = seen.get(baseIn);
  if (!pairs) seen.set(baseIn, (pairs = new Set()));
  if (pairs.has(headIn)) return;
  pairs.add(headIn);

  const base = mergeAllOf(baseIn);
  const head = mergeAllOf(headIn);
  const emit = (rule: RuleId, message: string, at: string[] = pointer) =>
    ctx.out.push({
      rule,
      severity: severityOf(rule, ctx.direction),
      operation: ctx.operation,
      direction: ctx.direction,
      where: ctx.label,
      message,
      pointer: at,
    });
  const name = field ? `\`${field}\`` : subject(ctx.label);
  const req = ctx.direction === 'request';

  // Types. `undefined` means "any".
  const bt = typesOf(base);
  const ht = typesOf(head);
  if (bt || ht) {
    const nonNull = (t?: Set<Type>) => t && new Set([...t].filter((x) => x !== 'null'));
    const bn = nonNull(bt);
    const hn = nonNull(ht);
    // Nullability only means something when both sides name their types.
    const nullB = bt ? bt.has('null') : undefined;
    const nullH = ht ? ht.has('null') : undefined;
    if (!sameTypes(bn, hn)) {
      const from = describe(bn);
      const to = describe(hn);
      if (accepts(hn, bn)) emit('type-widened', `${name} type widened from ${from} to ${to}`);
      else if (accepts(bn, hn)) emit('type-narrowed', `${name} type narrowed from ${from} to ${to}`);
      else emit('type-changed', `${name} type changed from ${from} to ${to}`);
    }
    if (nullB !== undefined && nullH !== undefined && nullB !== nullH) emit(nullH ? 'became-nullable' : 'no-longer-nullable', `${name} ${nullH ? 'can now be null' : 'can no longer be null'}`);
  }

  // Enums (`const` is a one-value enum).
  const be = enumOf(base);
  const he = enumOf(head);
  if (be && he) {
    const key = (v: unknown) => JSON.stringify(v);
    const bk = new Set(be.map(key));
    const hk = new Set(he.map(key));
    const added = he.filter((v) => !bk.has(key(v)) && v !== null);
    const removed = be.filter((v) => !hk.has(key(v)) && v !== null);
    if (added.length) emit('enum-value-added', `${name} allows new value${added.length > 1 ? 's' : ''} ${list(added)}`);
    if (removed.length) emit('enum-value-removed', `${name} no longer allows ${list(removed)}`);
  } else if (he) emit('enum-added', `${name} is now restricted to ${list(he)}`);
  else if (be) emit('enum-removed', `${name} is no longer restricted to ${list(be)}`);

  if (base.format !== head.format) {
    // Adding a format to a response (or dropping one from a request) only makes things more precise.
    const harmless = req ? head.format === undefined : base.format === undefined;
    if (!harmless) emit('format-changed', `${name} format changed from ${base.format ?? 'none'} to ${head.format ?? 'none'}`);
  }

  for (const [key, kind] of LIMITS) {
    const b = typeof base[key] === 'number' ? base[key] : undefined;
    const h = typeof head[key] === 'number' ? head[key] : undefined;
    if (b === h) continue;
    const tightened = kind === 'min' ? b === undefined || (h !== undefined && h > b) : kind === 'max' ? b === undefined || (h !== undefined && h < b) : h !== undefined;
    emit(tightened ? 'constraint-tightened' : 'constraint-loosened', `${name} ${key} changed from ${b ?? 'none'} to ${h ?? 'none'}`);
  }
  if (base.uniqueItems !== head.uniqueItems && (base.uniqueItems || head.uniqueItems)) {
    emit(head.uniqueItems ? 'constraint-tightened' : 'constraint-loosened', `${name} ${head.uniqueItems ? 'must now have unique items' : 'may now have duplicate items'}`);
  }
  if (base.pattern !== head.pattern && head.pattern !== undefined) {
    emit('pattern-changed', `${name} pattern changed from ${base.pattern ? `\`${base.pattern}\`` : 'none'} to \`${head.pattern}\``);
  } else if (base.pattern !== undefined && head.pattern === undefined) {
    emit('constraint-loosened', `${name} pattern \`${base.pattern}\` was removed`);
  }

  if (isObject(base, bt) && isObject(head, ht)) diffObject(base, head, pointer, field, ctx, seen, emit);

  if (isSchema(base.items) && isSchema(head.items)) {
    walk(base.items, head.items, [...pointer, 'items'], `${field || ''}[]`, ctx, seen);
  }

  for (const kw of ['oneOf', 'anyOf'] as const) diffVariants(base[kw], head[kw], kw, pointer, field, ctx, seen, emit);
}

const LIMITS: [string, 'min' | 'max' | 'other'][] = [
  ['minimum', 'min'],
  ['exclusiveMinimum', 'min'],
  ['minLength', 'min'],
  ['minItems', 'min'],
  ['minProperties', 'min'],
  ['maximum', 'max'],
  ['exclusiveMaximum', 'max'],
  ['maxLength', 'max'],
  ['maxItems', 'max'],
  ['maxProperties', 'max'],
  ['multipleOf', 'other'],
];

type Emit = (rule: RuleId, message: string, at?: string[]) => void;

/** What the root of a schema is called in messages. */
function subject(label: string): string {
  return /parameter/.test(label) ? 'the parameter' : /header/.test(label) ? 'the header' : 'the body';
}

function diffObject(base: Schema, head: Schema, pointer: string[], field: string, ctx: SchemaContext, seen: Seen, emit: Emit) {
  const req = ctx.direction === 'request';
  // readOnly properties are never sent; writeOnly ones are never returned.
  const visible = (s: Schema) => {
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries<Schema>(s.properties ?? {})) {
      if (isSchema(v) && (req ? v.readOnly : v.writeOnly)) continue;
      props[k] = v;
    }
    return props;
  };
  const bp = visible(base);
  const hp = visible(head);
  const breq = new Set<string>(Array.isArray(base.required) ? base.required : []);
  const hreq = new Set<string>(Array.isArray(head.required) ? head.required : []);
  const sub = (k: string) => (field ? `${field}.${k}` : k);
  const at = (k: string) => [...pointer, 'properties', k];

  for (const k of Object.keys(bp)) {
    if (k in hp) continue;
    if (req && head.additionalProperties === false) emit('property-removed-closed', `\`${sub(k)}\` was removed and extra properties are rejected`, at(k));
    else emit('property-removed', `\`${sub(k)}\` was removed`, at(k));
  }
  for (const k of Object.keys(hp)) {
    if (k in bp) continue;
    if (hreq.has(k)) emit('required-property-added', `new required property \`${sub(k)}\``, at(k));
    else emit('property-added', `new optional property \`${sub(k)}\``, at(k));
  }
  for (const k of Object.keys(bp)) {
    if (!(k in hp)) continue;
    if (!breq.has(k) && hreq.has(k)) emit('property-became-required', `\`${sub(k)}\` is now required`, at(k));
    if (breq.has(k) && !hreq.has(k)) emit('property-became-optional', `\`${sub(k)}\` is now optional${req ? '' : ' and may be missing'}`, at(k));
    walk(bp[k], hp[k], at(k), sub(k), ctx, seen);
  }

  const ba = base.additionalProperties;
  const ha = head.additionalProperties;
  const open = (a: unknown) => a === undefined || a === true || isSchema(a);
  if (open(ba) && ha === false) emit('additional-properties-restricted', `${field ? `\`${field}\`` : subject(ctx.label)} no longer allows extra properties`, [...pointer, 'additionalProperties']);
  else if (ba === false && open(ha)) emit('additional-properties-allowed', `${field ? `\`${field}\`` : subject(ctx.label)} now allows extra properties`, [...pointer, 'additionalProperties']);
  else if (isSchema(ba) && isSchema(ha)) walk(ba, ha, [...pointer, 'additionalProperties'], `${field || ''}{*}`, ctx, seen);
}

function diffVariants(b: unknown, h: unknown, kw: string, pointer: string[], field: string, ctx: SchemaContext, seen: Seen, emit: Emit) {
  const bv = Array.isArray(b) ? b.filter(isSchema) : [];
  const hv = Array.isArray(h) ? h.filter(isSchema) : [];
  if (!bv.length && !hv.length) return;
  const name = field ? `\`${field}\`` : subject(ctx.label);

  // Pair variants up: same title, else same shape, else (when counts match) by position.
  const pairs: [number, number][] = [];
  const usedH = new Set<number>();
  for (const match of [(s: Schema) => s.title, signature]) {
    bv.forEach((s, i) => {
      if (pairs.some(([bi]) => bi === i)) return;
      const key = match(s);
      if (key === undefined) return;
      const j = hv.findIndex((t, j) => !usedH.has(j) && match(t) === key);
      if (j !== -1) {
        pairs.push([i, j]);
        usedH.add(j);
      }
    });
  }
  const unmatchedB = bv.map((_, i) => i).filter((i) => !pairs.some(([bi]) => bi === i));
  const unmatchedH = hv.map((_, j) => j).filter((j) => !usedH.has(j));
  if (unmatchedB.length === unmatchedH.length) {
    unmatchedB.forEach((i, n) => pairs.push([i, unmatchedH[n]]));
  } else {
    const label = (s: Schema, i: number) => s.title ?? `#${i + 1}`;
    for (const j of unmatchedH) emit('variant-added', `${name} has a new ${kw} variant ${label(hv[j], j)}`, [...pointer, kw, String(j)]);
    for (const i of unmatchedB) emit('variant-removed', `${name} lost ${kw} variant ${label(bv[i], i)}`, [...pointer, kw]);
  }
  for (const [i, j] of pairs) walk(bv[i], hv[j], [...pointer, kw, String(j)], field, ctx, seen);
}

/** A variant's shape, for matching: its types and property names. */
function signature(s: Schema): string {
  const m = mergeAllOf(s);
  const t = typesOf(m);
  return `${t ? [...t].sort().join('|') : '*'}:${Object.keys(m.properties ?? {}).sort().join(',')}:${enumOf(m)?.map((v) => JSON.stringify(v)).join(',') ?? ''}`;
}

function isSchema(s: unknown): s is Schema {
  return !!s && typeof s === 'object' && !Array.isArray(s);
}

function typesOf(s: Schema): Set<Type> | undefined {
  let t: unknown = s.type;
  if (t === undefined) {
    if (s.properties || s.additionalProperties !== undefined) t = 'object';
    else if (s.items) t = 'array';
    else {
      const e = enumOf(s);
      if (!e) return undefined;
      t = [...new Set(e.map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)))];
    }
  }
  const out = new Set<Type>((Array.isArray(t) ? t : [t]).filter((x): x is Type => TYPES.includes(x)));
  if (s.nullable === true) out.add('null');
  return out.size ? out : undefined;
}

/** Whether every value of type set `inner` is also valid for `outer`. `undefined` is "any type". */
function accepts(outer: Set<Type> | undefined, inner: Set<Type> | undefined): boolean {
  if (!outer) return true;
  if (!inner) return false;
  return [...inner].every((t) => outer.has(t) || (t === 'integer' && outer.has('number')));
}

function sameTypes(a: Set<Type> | undefined, b: Set<Type> | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.size === b.size && [...a].every((t) => b.has(t));
}

function describe(t: Set<Type> | undefined): string {
  return t && t.size ? [...t].join(' | ') : 'any';
}

function isObject(s: Schema, t: Set<Type> | undefined): boolean {
  return !!(s.properties || t?.has('object'));
}

function enumOf(s: Schema): unknown[] | undefined {
  if ('const' in s) return [s.const];
  return Array.isArray(s.enum) ? s.enum : undefined;
}

function list(values: unknown[]): string {
  const shown = values.slice(0, 6).map((v) => `\`${JSON.stringify(v)}\``);
  return shown.join(', ') + (values.length > 6 ? ` and ${values.length - 6} more` : '');
}

/**
 * Merge `allOf` members into one schema so a property moved between members isn't seen as a change.
 * Properties and required lists combine; adapted from mockgen's `mergeAllOf`.
 */
export function mergeAllOf(schema: Schema, depth = 0): Schema {
  if (!Array.isArray(schema.allOf) || depth > 16) return schema;
  let merged = mergeCache.get(schema);
  if (merged) return merged;
  const { allOf, ...rest } = schema;
  merged = { ...rest };
  for (const part of allOf as Schema[]) {
    if (!isSchema(part)) continue;
    const flat = mergeAllOf(part, depth + 1);
    for (const [k, v] of Object.entries(flat)) {
      if (k === 'properties') merged.properties = { ...v, ...merged.properties };
      else if (k === 'required') merged.required = [...new Set([...(merged.required ?? []), ...v])];
      else if (!(k in merged)) merged[k] = v;
    }
  }
  mergeCache.set(schema, merged);
  return merged;
}

const mergeCache = new WeakMap<Schema, Schema>();

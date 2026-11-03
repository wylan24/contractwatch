import { mergeAllOf } from './schema-diff.ts';
import type { Schema } from './types.ts';

/**
 * Checks a real response body against its schema and says how they differ. Unlike a plain validator it
 * also reports fields the schema doesn't mention (drift), since an API that returns more than it documents
 * is one refactor away from a client depending on it.
 */

export type DriftRule =
  | 'type-mismatch'
  | 'missing-required'
  | 'enum-mismatch'
  | 'unexpected-property'
  | 'undocumented-property'
  | 'no-variant-matches'
  | 'format-mismatch'
  | 'constraint-violated';

export interface Mismatch {
  rule: DriftRule;
  /** Field path with array indexes blanked, so all items of an array report together: `items[].name`. */
  field: string;
  message: string;
  value: unknown;
}

/** Errors are spec violations; the rest is drift worth documenting. */
export const DRIFT_SEVERITY: Record<DriftRule, 'error' | 'warning'> = {
  'type-mismatch': 'error',
  'missing-required': 'error',
  'enum-mismatch': 'error',
  'unexpected-property': 'error',
  'no-variant-matches': 'error',
  'undocumented-property': 'warning',
  'format-mismatch': 'warning',
  'constraint-violated': 'warning',
};

export function validate(value: unknown, schema: Schema | undefined): Mismatch[] {
  const out: Mismatch[] = [];
  check(value, schema, '', out, 0);
  return out;
}

const MAX_DEPTH = 64;

function check(value: unknown, schemaIn: Schema | undefined, field: string, out: Mismatch[], depth: number): void {
  if (!schemaIn || typeof schemaIn !== 'object' || depth > MAX_DEPTH) return;
  const s = mergeAllOf(schemaIn);
  const name = field || 'the body';
  const push = (rule: DriftRule, message: string, f = field) => out.push({ rule, field: f, message, value });

  if (value === null) {
    const nullable = s.nullable === true || (Array.isArray(s.type) && s.type.includes('null')) || s.type === 'null' || (Array.isArray(s.enum) && s.enum.includes(null));
    if (!nullable && (s.type !== undefined || s.properties || s.items)) push('type-mismatch', `\`${name}\` is null, but the spec doesn't allow null`);
    return;
  }

  // oneOf/anyOf: fine when some branch fits without errors.
  for (const kw of ['oneOf', 'anyOf'] as const) {
    if (!Array.isArray(s[kw]) || !s[kw].length) continue;
    const results = s[kw].map((b: Schema) => {
      const r: Mismatch[] = [];
      check(value, b, field, r, depth + 1);
      return r;
    });
    const fits = results.filter((r: Mismatch[]) => !r.some((m) => DRIFT_SEVERITY[m.rule] === 'error'));
    if (!fits.length) {
      push('no-variant-matches', `\`${name}\` matches none of the ${kw} variants`);
      return;
    }
    // Report drift (undocumented fields) from the best-fitting branch.
    out.push(...fits.sort((a: Mismatch[], b: Mismatch[]) => a.length - b.length)[0]);
  }

  const types: string[] = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
    push('type-mismatch', `\`${name}\` is ${article(actual)}, but the spec says ${types.filter((t) => t !== 'null').join(' or ')}`);
    return;
  }

  const allowed = 'const' in s ? [s.const] : Array.isArray(s.enum) ? s.enum : undefined;
  if (allowed && !allowed.some((v: unknown) => JSON.stringify(v) === JSON.stringify(value))) {
    push('enum-mismatch', `\`${name}\` is ${show(value)}, which isn't one of ${allowed.slice(0, 6).map(show).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (s.format && FORMATS[s.format] && !FORMATS[s.format](value)) push('format-mismatch', `\`${name}\` is ${show(value)}, which isn't a valid ${s.format}`);
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) push('constraint-violated', `\`${name}\` is longer than maxLength ${s.maxLength}`);
    if (typeof s.minLength === 'number' && value.length < s.minLength) push('constraint-violated', `\`${name}\` is shorter than minLength ${s.minLength}`);
    if (typeof s.pattern === 'string' && !safeTest(s.pattern, value)) push('constraint-violated', `\`${name}\` doesn't match pattern \`${s.pattern}\``);
  }
  if (typeof value === 'number') {
    if (typeof s.maximum === 'number' && value > s.maximum) push('constraint-violated', `\`${name}\` is above maximum ${s.maximum}`);
    if (typeof s.minimum === 'number' && value < s.minimum) push('constraint-violated', `\`${name}\` is below minimum ${s.minimum}`);
  }

  if (Array.isArray(value)) {
    if (s.items) for (const item of value) check(item, s.items, `${field}[]`, out, depth + 1);
    return;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const props: Record<string, Schema> = s.properties ?? {};
    const sub = (k: string) => (field ? `${field}.${k}` : k);
    for (const k of Array.isArray(s.required) ? s.required : []) {
      // A writeOnly property is never returned, so its absence from a response isn't a mismatch.
      if (!(k in obj) && !props[k]?.writeOnly) push('missing-required', `required \`${sub(k)}\` is missing`, sub(k));
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) check(v, props[k], sub(k), out, depth + 1);
      else if (s.additionalProperties === false) out.push({ rule: 'unexpected-property', field: sub(k), message: `\`${sub(k)}\` isn't in the spec, which allows no other properties`, value: v });
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(v, s.additionalProperties, `${field}{*}`, out, depth + 1);
      // Open objects (`additionalProperties` unset) are only flagged when they declare properties at all.
      else if (s.properties) out.push({ rule: 'undocumented-property', field: sub(k), message: `\`${sub(k)}\` isn't documented`, value: v });
    }
  }
}

const FORMATS: Record<string, (s: string) => boolean> = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  email: (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s),
  uri: (s) => URL.canParse(s),
};

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return true;
  }
}

function article(t: string): string {
  return `${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}`;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return `\`${s.length > 40 ? `${s.slice(0, 37)}…` : s}\``;
}

/** A JSON type name for a value, for proposing a schema for an undocumented field. */
export function jsonType(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
}

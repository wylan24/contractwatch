import { type Change, type DiffResult, SEVERITIES, type Severity } from '../types.ts';

export function counts(result: DiffResult): Record<Severity, number> {
  const c = { breaking: 0, warning: 0, info: 0 };
  for (const ch of result.changes) c[ch.severity]++;
  return c;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const SEVERITY_LABEL: Record<Severity, string> = { breaking: 'Breaking', warning: 'Warning', info: 'Non-breaking' };

/** Changes of one severity, grouped by operation in first-seen order (document-level changes under ''). */
export function groupByOperation(changes: Change[], severity: Severity): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  for (const c of changes) {
    if (c.severity !== severity) continue;
    const key = c.operation ?? '';
    let list = out.get(key);
    if (!list) out.set(key, (list = []));
    list.push(c);
  }
  return out;
}

export { SEVERITIES };

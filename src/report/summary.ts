import { type Change, type DiffResult, SEVERITIES, type Severity } from '../types.ts';

/** Changes per severity, not counting accepted ones (those are in `accepted`). */
export function counts(result: DiffResult): Record<Severity | 'accepted', number> {
  const c = { breaking: 0, warning: 0, info: 0, accepted: 0 };
  for (const ch of result.changes) c[ch.accepted ? 'accepted' : ch.severity]++;
  return c;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const SEVERITY_LABEL: Record<Severity, string> = { breaking: 'Breaking', warning: 'Warning', info: 'Non-breaking' };

/**
 * Changes of one severity (or the accepted ones), grouped by operation in first-seen order. Document-level
 * changes are under ''.
 */
export function groupByOperation(changes: Change[], severity: Severity | 'accepted'): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  for (const c of changes) {
    if (severity === 'accepted' ? !c.accepted : c.accepted || c.severity !== severity) continue;
    const key = c.operation ?? '';
    let list = out.get(key);
    if (!list) out.set(key, (list = []));
    list.push(c);
  }
  return out;
}

export { SEVERITIES };

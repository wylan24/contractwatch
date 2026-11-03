import { type Change, type DiffResult, SEVERITIES, type Severity } from '../types.ts';

type Bucket = Severity | 'accepted';

const bucketOf = (c: Change): Bucket => (c.accepted ? 'accepted' : c.severity);

/**
 * Distinct changes per severity, not counting accepted ones (those are in `accepted`). A change to a shared
 * schema counts once, however many operations use the schema.
 */
export function counts(result: DiffResult): Record<Bucket, number> {
  const seen = { breaking: new Set<string>(), warning: new Set<string>(), info: new Set<string>(), accepted: new Set<string>() };
  for (const ch of result.changes) seen[bucketOf(ch)].add(ch.id);
  return { breaking: seen.breaking.size, warning: seen.warning.size, info: seen.info.size, accepted: seen.accepted.size };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const SEVERITY_LABEL: Record<Severity, string> = { breaking: 'Breaking', warning: 'Warning', info: 'Non-breaking' };

/** One line in a report: a change, and every operation it occurs in. */
export interface Entry {
  change: Change;
  /** Set when the change is in a shared schema and occurs in more than one place. */
  component?: string;
  /** The change as it reads in that schema (`Pet.tag was removed`), or the plain message. */
  message: string;
  operations: string[];
}

/**
 * The changes in one bucket, grouped for display. Changes in a shared schema that occur in several places
 * come first, under `schema <Name>`; everything else is under its operation ('' for document-level ones),
 * in first-seen order.
 */
export function groupEntries(changes: Change[], bucket: Bucket): Map<string, Entry[]> {
  const byId = new Map<string, Change[]>();
  for (const c of changes) {
    if (bucketOf(c) !== bucket) continue;
    let list = byId.get(c.id);
    if (!list) byId.set(c.id, (list = []));
    list.push(c);
  }

  const shared = new Map<string, Entry[]>();
  const single = new Map<string, Entry[]>();
  const add = (map: Map<string, Entry[]>, key: string, e: Entry) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(e);
  };
  for (const list of byId.values()) {
    const first = list[0];
    const places = new Set(list.map((c) => `${c.operation} ${c.where}`));
    const operations = [...new Set(list.map((c) => c.operation ?? ''))];
    if (first.component && places.size > 1) {
      add(shared, `schema ${first.component}`, { change: first, component: first.component, message: first.componentMessage ?? first.message, operations });
    } else {
      const done = new Set<string>();
      for (const c of list) {
        const place = `${c.operation} ${c.where}`;
        if (done.has(place)) continue;
        done.add(place);
        add(single, c.operation ?? '', { change: c, message: c.message, operations: [c.operation ?? ''] });
      }
    }
  }
  return new Map([...shared, ...single]);
}

/** `GET /pets, POST /pets and 2 more`. */
export function listOperations(ops: string[], wrap = (s: string) => s, max = 3): string {
  const shown = ops.slice(0, max).map(wrap).join(', ');
  return ops.length > max ? `${shown} and ${ops.length - max} more` : shown;
}

export { SEVERITIES };

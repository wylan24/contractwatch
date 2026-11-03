import { createHash } from 'node:crypto';
import { Locator } from '../locate.ts';
import { RULES, type RuleId } from '../rules.ts';
import type { DiffResult, Severity } from '../types.ts';
import { type Entry, groupEntries, listOperations, SEVERITIES } from './summary.ts';

/**
 * SARIF 2.1.0 for GitHub code scanning. Each change is anchored to its line in the head spec, and its
 * fingerprint ignores line numbers so an alert survives unrelated edits above it. A change to a shared
 * schema is one alert on the schema's line, not one per operation.
 */

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { breaking: 'error', warning: 'warning', info: 'note' };

export function renderSarif(result: DiffResult, headText: string, version: string): string {
  const locator = new Locator(headText);
  const used = new Set<string>();
  const entries: Entry[] = [];
  for (const bucket of [...SEVERITIES, 'accepted'] as const) for (const list of groupEntries(result.changes, bucket).values()) entries.push(...list);
  const results = entries.map((e) => {
    const ch = e.change;
    used.add(ch.rule);
    return {
      ruleId: ch.rule,
      level: LEVEL[ch.severity],
      message: { text: text(e) },
      locations: [{ physicalLocation: { artifactLocation: { uri: result.head.file }, region: { startLine: locator.line(ch.pointer) } } }],
      partialFingerprints: { contractwatch: fingerprint(e) },
      ...(ch.accepted ? { suppressions: [{ kind: 'external', justification: ch.accepted }] } : {}),
      properties: { id: ch.id, severity: ch.severity, operations: e.operations.filter(Boolean), direction: ch.direction, component: e.component },
    };
  });

  const rules = [...used].map((id) => ({
    id,
    shortDescription: { text: RULES[id as RuleId].title },
    helpUri: 'https://github.com/wylan24/contractwatch#rules',
    properties: { tags: ['api', 'openapi'] },
  }));

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'contractwatch', version, informationUri: 'https://github.com/wylan24/contractwatch', rules } }, results }],
  };
  return JSON.stringify(sarif, null, 2) + '\n';
}

function text(e: Entry): string {
  const msg = e.message.replace(/`/g, "'");
  if (e.component) return `${msg} (schema ${e.component}, used by ${listOperations(e.operations)})`;
  const prefix = [e.change.operation, e.change.where].filter(Boolean).join(' · ');
  return `${prefix ? `${prefix}: ` : ''}${msg}`;
}

function fingerprint(e: Entry): string {
  const ch = e.change;
  const parts = e.component ? [ch.id, e.message] : [ch.rule, ch.operation ?? '', ch.where ?? '', ch.message];
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

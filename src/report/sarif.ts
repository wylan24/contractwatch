import { createHash } from 'node:crypto';
import { Locator } from '../locate.ts';
import { RULES, type RuleId } from '../rules.ts';
import type { Change, DiffResult, Severity } from '../types.ts';

/**
 * SARIF 2.1.0 for GitHub code scanning. Each change is anchored to its line in the head spec, and its
 * fingerprint ignores line numbers so an alert survives unrelated edits above it.
 */

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { breaking: 'error', warning: 'warning', info: 'note' };

export function renderSarif(result: DiffResult, headText: string, version: string): string {
  const locator = new Locator(headText);
  const used = new Set<string>();
  const results = result.changes.map((ch) => {
    used.add(ch.rule);
    return {
      ruleId: ch.rule,
      level: LEVEL[ch.severity],
      message: { text: text(ch) },
      locations: [{ physicalLocation: { artifactLocation: { uri: result.head.file }, region: { startLine: locator.line(ch.pointer) } } }],
      partialFingerprints: { contractwatch: fingerprint(ch) },
      ...(ch.accepted ? { suppressions: [{ kind: 'external', justification: ch.accepted }] } : {}),
      properties: { id: ch.id, severity: ch.severity, operation: ch.operation, direction: ch.direction },
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

function text(ch: Change): string {
  const prefix = [ch.operation, ch.where].filter(Boolean).join(' · ');
  return `${prefix ? `${prefix}: ` : ''}${ch.message.replace(/`/g, "'")}`;
}

function fingerprint(ch: Change): string {
  return createHash('sha256').update([ch.rule, ch.operation ?? '', ch.where ?? '', ch.message].join('\0')).digest('hex').slice(0, 32);
}

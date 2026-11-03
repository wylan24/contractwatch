import type { Change, DiffResult, Severity } from '../types.ts';
import { counts, groupByOperation, plural, SEVERITY_LABEL } from './summary.ts';

/** Hidden marker the GitHub Action uses to find and update its own PR comment instead of posting a new one. */
export const COMMENT_MARKER = '<!-- contractwatch -->';

const ICON: Record<Severity, string> = { breaking: '🔴', warning: '🟡', info: '🟢' };

/** Markdown for a PR comment or job summary. Breaking and warnings are listed; non-breaking changes are folded. */
export function renderMarkdown(result: DiffResult): string {
  const c = counts(result);
  const out: string[] = [COMMENT_MARKER];
  const spec = `\`${result.head.file}\``;

  if (c.breaking) out.push(`### ${ICON.breaking} ${plural(c.breaking, 'breaking change')} in ${spec}`, '', 'These changes will break existing clients.');
  else if (result.changes.length) out.push(`### ✅ No breaking changes in ${spec}`);
  else out.push(`### ✅ No API contract changes in ${spec}`);

  const tally = (['breaking', 'warning', 'info'] as const).filter((s) => c[s]).map((s) => `${ICON[s]} ${c[s]} ${SEVERITY_LABEL[s].toLowerCase()}`);
  if (tally.length) out.push('', tally.join(' · '));

  for (const sev of ['breaking', 'warning', 'info'] as const) {
    if (!c[sev]) continue;
    const table = section(result.changes, sev);
    if (sev === 'breaking') out.push('', `#### ${SEVERITY_LABEL[sev]}`, '', table);
    else out.push('', `<details><summary>${ICON[sev]} ${plural(c[sev], sev === 'warning' ? 'warning' : 'non-breaking change')}</summary>`, '', table, '', '</details>');
  }

  const side = (s: DiffResult['base']) => `\`${s.file}\`${s.source === 'working tree' ? '' : ` at \`${s.source}\``}${s.version ? ` (v${s.version})` : ''}`;
  out.push('', `<sub>Compared ${side(result.base)} with ${side(result.head)} · contractwatch</sub>`);
  return out.join('\n') + '\n';
}

function section(changes: Change[], sev: Severity): string {
  const rows = ['| Operation | Where | Change |', '| --- | --- | --- |'];
  for (const [op, list] of groupByOperation(changes, sev)) {
    for (const ch of list) rows.push(`| ${op ? `\`${op}\`` : 'Document'} | ${cell(ch.where ?? '')} | ${cell(ch.message)} <sub>\`${ch.rule}\`</sub> |`);
  }
  return rows.join('\n');
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

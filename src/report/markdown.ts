import type { Change, DiffResult, Severity } from '../types.ts';
import { counts, groupEntries, listOperations, plural, SEVERITY_LABEL } from './summary.ts';

/** Hidden marker the GitHub Action uses to find and update its own PR comment instead of posting a new one. */
export const COMMENT_MARKER = '<!-- contractwatch -->';

const ICON: Record<Severity, string> = { breaking: '🔴', warning: '🟡', info: '🟢' };

/** Markdown for a PR comment or job summary. Breaking changes are listed; everything else is folded. */
export function renderMarkdown(result: DiffResult): string {
  const c = counts(result);
  const out: string[] = [COMMENT_MARKER];
  const spec = `\`${result.head.file}\``;

  if (c.breaking) out.push(`### ${ICON.breaking} ${plural(c.breaking, 'breaking change')} in ${spec}`, '', 'These changes will break existing clients.');
  else if (result.changes.length) out.push(`### ✅ No breaking changes in ${spec}`);
  else out.push(`### ✅ No API contract changes in ${spec}`);

  const noun: Record<Severity, string> = { breaking: 'breaking', warning: 'warning', info: 'non-breaking' };
  const tally = (['breaking', 'warning', 'info'] as const).filter((s) => c[s]).map((s) => `${ICON[s]} ${s === 'warning' ? plural(c[s], 'warning') : `${c[s]} ${noun[s]}`}`);
  if (c.accepted) tally.push(`✔️ ${c.accepted} accepted`);
  if (tally.length) out.push('', tally.join(' · '));

  for (const sev of ['breaking', 'warning', 'info'] as const) {
    if (!c[sev]) continue;
    const table = section(result.changes, sev);
    if (sev === 'breaking') {
      out.push('', `#### ${SEVERITY_LABEL[sev]}`, '', table);
      out.push('', '<sub>Breaking on purpose? Add the change id to `accept` in `.contractwatch.json`, with a reason.</sub>');
    } else {
      out.push('', `<details><summary>${ICON[sev]} ${plural(c[sev], sev === 'warning' ? 'warning' : 'non-breaking change')}</summary>`, '', table, '', '</details>');
    }
  }
  if (c.accepted) out.push('', `<details><summary>✔️ ${plural(c.accepted, 'accepted change')}</summary>`, '', section(result.changes, 'accepted'), '', '</details>');
  for (const note of result.notes) out.push('', `> [!NOTE]\n> ${note}`);

  const side = (s: DiffResult['base']) => `\`${s.file}\`${s.source === 'working tree' ? '' : ` at \`${s.source}\``}${s.version ? ` (v${s.version})` : ''}`;
  out.push('', `<sub>Compared ${side(result.base)} with ${side(result.head)} · contractwatch</sub>`);
  return out.join('\n') + '\n';
}

function section(changes: Change[], sev: Severity | 'accepted'): string {
  const accepted = sev === 'accepted';
  const rows = [`| Operation | Where | Change | ${accepted ? 'Reason' : 'Id'} |`, '| --- | --- | --- | --- |'];
  for (const [key, entries] of groupEntries(changes, sev)) {
    for (const e of entries) {
      const ch = e.change;
      const last = accepted ? cell(ch.accepted ?? '') : `\`${ch.id}\``;
      // A shared schema's change is one row, listing every operation it affects.
      const op = e.component ? listOperations(e.operations, (o) => `\`${o}\``) : key ? `\`${key}\`` : 'Document';
      const where = e.component ? `schema \`${e.component}\`` : cell(ch.where ?? '');
      rows.push(`| ${op} | ${where} | ${cell(e.message)} <sub>\`${ch.rule}\`</sub> | ${last} |`);
    }
  }
  return rows.join('\n');
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

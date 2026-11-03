import type { DiffResult, Severity } from '../types.ts';
import { counts, type Entry, groupEntries, listOperations, plural, SEVERITIES, SEVERITY_LABEL } from './summary.ts';

export interface TextOptions {
  color: boolean;
  /** List non-breaking changes too, not just their count. */
  all: boolean;
}

export function renderText(result: DiffResult, opts: TextOptions): string {
  const paint = (code: string) => (s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const COLOR: Record<Severity, (s: string) => string> = { breaking: paint('31'), warning: paint('33'), info: paint('36') };
  const ICON: Record<Severity, string> = { breaking: '✖', warning: '!', info: '+' };
  const plain = (s: string) => s.replace(/`/g, '');

  const c = counts(result);
  const lines: string[] = [];
  const side = (s: DiffResult['base']) => `${s.file}${s.source === 'working tree' ? '' : ` @ ${s.source}`}${s.version ? dim(` (v${s.version})`) : ''}`;
  lines.push(`${bold('contractwatch')}  ${side(result.base)} → ${side(result.head)}`, '');

  const entryLines = (e: Entry, icon: string, suffix = '') => {
    const where = !e.component && e.change.where ? dim(`${plain(e.change.where)} · `) : '';
    lines.push(`    ${icon} ${where}${plain(e.message)} ${dim(`[${e.change.rule} ${e.change.id}]`)}${suffix}`);
    if (e.component) lines.push(dim(`      in ${plural(e.operations.length, 'operation')}: ${listOperations(e.operations)}`));
  };
  const heading = (key: string) => (key.startsWith('schema ') ? `Schema ${key.slice(7)}` : key || 'Document');

  for (const sev of SEVERITIES) {
    if (!c[sev]) continue;
    if (sev === 'info' && !opts.all) {
      lines.push(dim(`${plural(c.info, 'non-breaking change')} not shown (use --all to list them)`), '');
      continue;
    }
    lines.push(COLOR[sev](bold(`${SEVERITY_LABEL[sev]} (${c[sev]})`)));
    for (const [key, entries] of groupEntries(result.changes, sev)) {
      lines.push(`  ${bold(heading(key))}`);
      for (const e of entries) entryLines(e, COLOR[sev](ICON[sev]));
    }
    lines.push('');
  }

  if (c.accepted) {
    lines.push(bold(`Accepted (${c.accepted})`));
    for (const [key, entries] of groupEntries(result.changes, 'accepted')) {
      lines.push(`  ${bold(heading(key))}`);
      for (const e of entries) entryLines(e, '✔', dim(`: ${e.change.accepted}`));
    }
    lines.push('');
  }
  for (const note of result.notes) lines.push(COLOR.warning(`note: ${note}`));
  if (result.notes.length) lines.push('');

  if (!result.changes.length) lines.push('No changes to the API contract.');
  else if (!c.breaking) lines.push(COLOR.info(`No breaking changes.`) + (c.warning ? ` ${plural(c.warning, 'warning')} to review.` : ''));
  else {
    lines.push(COLOR.breaking(bold(`${plural(c.breaking, 'breaking change')} will break existing clients.`)));
    lines.push(dim(`If a break is intended, add its id to "accept" in .contractwatch.json with a reason.`));
  }
  return lines.join('\n') + '\n';
}

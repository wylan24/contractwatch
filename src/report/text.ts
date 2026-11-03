import type { DiffResult, Severity } from '../types.ts';
import { counts, groupByOperation, plural, SEVERITIES, SEVERITY_LABEL } from './summary.ts';

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

  const c = counts(result);
  const lines: string[] = [];
  const side = (s: DiffResult['base']) => `${s.file}${s.source === 'working tree' ? '' : ` @ ${s.source}`}${s.version ? dim(` (v${s.version})`) : ''}`;
  lines.push(`${bold('contractwatch')}  ${side(result.base)} → ${side(result.head)}`, '');

  for (const sev of SEVERITIES) {
    if (!c[sev]) continue;
    if (sev === 'info' && !opts.all) {
      lines.push(dim(`${plural(c.info, 'non-breaking change')} not shown (use --all to list them)`), '');
      continue;
    }
    lines.push(COLOR[sev](bold(`${SEVERITY_LABEL[sev]} (${c[sev]})`)));
    for (const [op, changes] of groupByOperation(result.changes, sev)) {
      lines.push(`  ${bold(op || 'Document')}`);
      for (const ch of changes) {
        const where = ch.where ? dim(`${ch.where.replace(/`/g, '')} · `) : '';
        lines.push(`    ${COLOR[sev](ICON[sev])} ${where}${ch.message.replace(/`/g, '')} ${dim(`[${ch.rule} ${ch.id}]`)}`);
      }
    }
    lines.push('');
  }

  if (c.accepted) {
    lines.push(bold(`Accepted (${c.accepted})`));
    for (const [op, changes] of groupByOperation(result.changes, 'accepted')) {
      lines.push(`  ${bold(op || 'Document')}`);
      for (const ch of changes) lines.push(dim(`    ✔ ${ch.message.replace(/`/g, '')} [${ch.rule} ${ch.id}]: ${ch.accepted}`));
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

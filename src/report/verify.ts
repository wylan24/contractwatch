import { type Finding, proposedSchema, type VerifyResult } from '../verify.ts';
import { plural } from './summary.ts';

/** Reports for `contractwatch verify`: terminal text and Markdown (job summary, PR comment). */

const counts = (r: VerifyResult) => ({
  error: r.findings.filter((f) => f.severity === 'error').length,
  warning: r.findings.filter((f) => f.severity === 'warning').length,
});

const times = (n: number) => (n === 1 ? '' : ` (×${n})`);

function hint(f: Finding): string {
  return f.seenTypes ? `document it as ${proposedSchema(f.seenTypes)}` : '';
}

export function renderVerifyText(r: VerifyResult, color: boolean): string {
  const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = paint('1');
  const dim = paint('2');
  const red = paint('31');
  const yellow = paint('33');
  const plain = (s: string) => s.replace(/`/g, '');
  const c = counts(r);
  const lines = [
    `${bold('contractwatch verify')}  ${r.spec.file}${r.spec.version ? dim(` (v${r.spec.version})`) : ''} against ${r.traffic}`,
    dim(`${plural(r.requests, 'request')}, ${r.matched} matched the spec · ${r.exercised.length} of ${plural(r.operations.length, 'operation')} exercised`),
    '',
  ];
  for (const sev of ['error', 'warning'] as const) {
    const list = r.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    lines.push((sev === 'error' ? red : yellow)(bold(`${sev === 'error' ? 'Responses that break the spec' : 'Drift to document'} (${list.length})`)));
    let op = '';
    for (const f of list) {
      if (f.operation !== op) lines.push(`  ${bold((op = f.operation))}`);
      const status = f.status ? dim(`${f.status} · `) : '';
      const extra = hint(f) ? dim(` → ${hint(f)}`) : '';
      lines.push(`    ${sev === 'error' ? red('✖') : yellow('!')} ${status}${plain(f.message)}${dim(times(f.count))} ${dim(`[${f.rule}]`)}${extra}`);
    }
    lines.push('');
  }
  const unseen = r.operations.filter((o) => !r.exercised.includes(o));
  if (unseen.length) lines.push(dim(`Not exercised: ${unseen.slice(0, 8).join(', ')}${unseen.length > 8 ? ` and ${unseen.length - 8} more` : ''}`), '');
  if (!r.matched) lines.push(yellow('No request in the traffic matched an operation in the spec. Is it the right spec, or does `servers` need the base path?'));
  else if (c.error) lines.push(red(bold(`${plural(c.error, 'mismatch', 'mismatches')} between the spec and the real API.`)));
  else lines.push(`The API's responses match the spec.${c.warning ? ` ${plural(c.warning, 'difference')} to document.` : ''}`);
  return lines.join('\n') + '\n';
}

export function renderVerifyMarkdown(r: VerifyResult): string {
  const c = counts(r);
  const out = ['<!-- contractwatch-verify -->'];
  out.push(c.error ? `### 🔴 The real API doesn't match \`${r.spec.file}\`` : `### ✅ The real API matches \`${r.spec.file}\``);
  out.push('', `${plural(r.requests, 'request')} from \`${r.traffic}\`, ${r.matched} matched · ${r.exercised.length} of ${plural(r.operations.length, 'operation')} exercised`);
  for (const sev of ['error', 'warning'] as const) {
    const list = r.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    const rows = ['| Operation | Status | Finding | Seen |', '| --- | --- | --- | --- |'];
    for (const f of list) {
      const h = hint(f) ? ` <sub>${hint(f)}</sub>` : '';
      rows.push(`| \`${f.operation}\` | ${f.status ?? ''} | ${f.message.replace(/\|/g, '\\|')}${h} <sub>\`${f.rule}\`</sub> | ${f.count} |`);
    }
    const title = sev === 'error' ? `🔴 ${plural(list.length, 'response mismatch', 'response mismatches')}` : `🟡 ${plural(list.length, 'difference')} to document`;
    if (sev === 'error') out.push('', `#### ${title}`, '', rows.join('\n'));
    else out.push('', `<details><summary>${title}</summary>`, '', rows.join('\n'), '', '</details>');
  }
  return out.join('\n') + '\n';
}

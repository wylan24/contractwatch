import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Merge one SARIF file per spec into a single run. Code scanning rejects several runs of the same tool
 * under one category, so the Action uploads this instead of the separate files.
 *
 *   node merge-sarif.ts out.sarif a.sarif b.sarif …
 */
const [out, ...inputs] = process.argv.slice(2);
const files = inputs.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const merged = files[0];
const run = merged.runs[0];
const rules = new Map(run.tool.driver.rules.map((r: { id: string }) => [r.id, r]));
for (const file of files.slice(1)) {
  for (const r of file.runs[0].tool.driver.rules) if (!rules.has(r.id)) rules.set(r.id, r);
  run.results.push(...file.runs[0].results);
}
run.tool.driver.rules = [...rules.values()];
writeFileSync(out, JSON.stringify(merged, null, 2) + '\n');

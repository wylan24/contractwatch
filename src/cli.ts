#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { addAcceptances, applyConfig, ConfigError, configPathFor, findConfig, loadConfig } from './config.ts';
import { diffSpecs } from './diff.ts';
import { loadSpec, loadSpecAtRef, NotAtRefError, SpecLoadError } from './load.ts';
import { renderMarkdown } from './report/markdown.ts';
import { renderSarif } from './report/sarif.ts';
import { counts } from './report/summary.ts';
import { renderText } from './report/text.ts';
import { renderVerifyMarkdown, renderVerifyText } from './report/verify.ts';
import type { DiffResult, Spec } from './types.ts';
import { readHar, TrafficError, verify } from './verify.ts';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `contractwatch ${VERSION}: catch breaking changes in OpenAPI specs

Usage
  contractwatch diff <base-spec> <head-spec>       compare two spec files
  contractwatch diff <spec> --base <git-ref>       compare a spec with itself at a git ref (e.g. origin/main)
  contractwatch verify <spec> --har <file>         check recorded traffic against the spec
  contractwatch accept <id>... --reason <text>     record breaking changes made on purpose

diff options
  --base <ref>        read the base spec from this git ref
  --format <fmt>      stdout format: text (default), markdown, json
  --markdown <file>   also write a Markdown report (PR comment / job summary)
  --json <file>       also write a JSON report
  --sarif <file>      also write SARIF for GitHub code scanning
  --fail-on <level>   exit 1 on: breaking (default), warning, never
  --config <file>     settings and accepted changes (default: nearest .contractwatch.json)
  --no-config         ignore .contractwatch.json
  --all               list non-breaking changes too (text format)

verify options
  --har <file>        traffic recorded as HAR (browser devtools, Playwright, mitmproxy, Charles…)
  --format, --markdown, --json   as for diff
  --fail-on <level>   exit 1 on: error (default), warning, never

accept options
  --reason <text>     why the break is intended (required)
  --expires <date>    YYYY-MM-DD after which the acceptance stops applying
  --config <file>     file to update (default: nearest .contractwatch.json, else one at the repository root)

  --no-color          plain output (also when NO_COLOR is set)
  -v, --version
  -h, --help

Exit codes: 0 no failing changes, 1 failing changes found, 2 contractwatch couldn't run.
`;

const OPTIONS = {
  base: { type: 'string' },
  har: { type: 'string' },
  format: { type: 'string', default: 'text' },
  markdown: { type: 'string' },
  json: { type: 'string' },
  sarif: { type: 'string' },
  'fail-on': { type: 'string' },
  config: { type: 'string' },
  'no-config': { type: 'boolean', default: false },
  reason: { type: 'string' },
  expires: { type: 'string' },
  all: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  if (values.version) return void console.log(VERSION), 0;
  const [command, ...args] = positionals;
  if (values.help || !command) return void console.log(HELP), 0;
  if (!['text', 'markdown', 'json'].includes(values.format)) return usage(`--format must be text, markdown or json`);
  if (command === 'diff') return diffCommand(args, values);
  if (command === 'verify') return verifyCommand(args, values);
  if (command === 'accept') return acceptCommand(args, values);
  return usage(`unknown command "${command}"`);
}

const useColor = (values: Values) => !values['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY === true;

async function diffCommand(files: string[], values: Values): Promise<number> {
  const failOn = values['fail-on'] ?? 'breaking';
  if (!['breaking', 'warning', 'never'].includes(failOn)) return usage(`--fail-on must be breaking, warning or never`);

  let base: Spec;
  let head: Spec;
  if (values.base !== undefined) {
    if (files.length !== 1) return usage('with --base, pass exactly one spec file');
    head = await loadSpec(files[0]);
    try {
      base = await loadSpecAtRef(files[0], values.base);
    } catch (err) {
      if (!(err instanceof NotAtRefError)) throw err;
      // A new spec has no contract to break yet.
      console.log(`${head.file} is new since ${values.base}; nothing to compare.`);
      return 0;
    }
  } else {
    if (files.length !== 2) return usage('pass a base and a head spec, or one spec with --base <git-ref>');
    [base, head] = await Promise.all([loadSpec(files[0]), loadSpec(files[1])]);
  }

  let result = diffSpecs(base, head);
  const configFile = values['no-config'] ? undefined : (values.config ?? findConfig(process.cwd()) ?? findConfig(path.dirname(path.resolve(files.at(-1)!))));
  if (configFile) result = applyConfig(result, loadConfig(configFile));
  const json = () => JSON.stringify({ ...result, summary: counts(result) }, null, 2) + '\n';
  const stdout = values.format === 'json' ? json() : values.format === 'markdown' ? renderMarkdown(result) : renderText(result, { color: useColor(values), all: values.all });
  process.stdout.write(stdout);
  if (values.markdown) writeFileSync(values.markdown, renderMarkdown(result));
  if (values.json) writeFileSync(values.json, json());
  if (values.sarif) writeFileSync(values.sarif, renderSarif(result, head.text, VERSION));

  return failed(result, failOn) ? 1 : 0;
}

function failed(result: DiffResult, failOn: string): boolean {
  const c = counts(result);
  if (failOn === 'never') return false;
  return c.breaking > 0 || (failOn === 'warning' && c.warning > 0);
}

async function verifyCommand(files: string[], values: Values): Promise<number> {
  const failOn = values['fail-on'] ?? 'error';
  if (!['error', 'warning', 'never'].includes(failOn)) return usage(`--fail-on must be error, warning or never`);
  if (files.length !== 1) return usage('pass one spec file');
  if (!values.har) return usage('pass the recorded traffic with --har <file>');

  const spec = await loadSpec(files[0]);
  const result = verify(spec, readHar(values.har), path.relative(process.cwd(), path.resolve(values.har)).split(path.sep).join('/'));
  const json = () => JSON.stringify(result, null, 2) + '\n';
  const stdout = values.format === 'json' ? json() : values.format === 'markdown' ? renderVerifyMarkdown(result) : renderVerifyText(result, useColor(values));
  process.stdout.write(stdout);
  if (values.markdown) writeFileSync(values.markdown, renderVerifyMarkdown(result));
  if (values.json) writeFileSync(values.json, json());

  if (failOn === 'never') return 0;
  return result.findings.some((f) => f.severity === 'error' || failOn === 'warning') ? 1 : 0;
}

function acceptCommand(ids: string[], values: Values): number {
  if (!ids.length) return usage('pass the ids of the changes to accept, as shown in the report');
  const bad = ids.find((id) => !/^[0-9a-f]{8}$/.test(id));
  if (bad) return usage(`"${bad}" isn't a change id; ids are 8 characters, like 3fa2c1d0`);
  if (!values.reason?.trim()) return usage('say why with --reason "…"; it is shown in the report');
  if (values.expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.expires)) return usage('--expires must be a YYYY-MM-DD date');

  const file = values.config ?? configPathFor(process.cwd());
  const entries = ids.map((id) => ({ id, reason: values.reason!.trim(), ...(values.expires ? { expires: values.expires } : {}) }));
  const { added, updated } = addAcceptances(file, entries);
  const shown = path.relative(process.cwd(), file) || file;
  if (added.length) console.log(`Accepted ${added.join(', ')} in ${shown}.`);
  if (updated.length) console.log(`Updated ${updated.join(', ')} in ${shown}.`);
  return 0;
}

function usage(message: string): number {
  console.error(`contractwatch: ${message}\nRun \`contractwatch --help\` for usage.`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    const known = err instanceof SpecLoadError || err instanceof ConfigError || err instanceof TrafficError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    console.error(known ? `contractwatch: ${(err as Error).message}` : err);
    process.exitCode = 2;
  },
);

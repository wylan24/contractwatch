#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { diffSpecs } from './diff.ts';
import { loadSpec, loadSpecAtRef, NotAtRefError, SpecLoadError } from './load.ts';
import { renderMarkdown } from './report/markdown.ts';
import { renderSarif } from './report/sarif.ts';
import { counts } from './report/summary.ts';
import { renderText } from './report/text.ts';
import type { DiffResult, Spec } from './types.ts';

const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `contractwatch ${VERSION}: catch breaking changes in OpenAPI specs

Usage
  contractwatch diff <base-spec> <head-spec>    compare two spec files
  contractwatch diff <spec> --base <git-ref>    compare a spec with itself at a git ref (e.g. origin/main)

Options
  --base <ref>        read the base spec from this git ref
  --format <fmt>      stdout format: text (default), markdown, json
  --markdown <file>   also write a Markdown report (PR comment / job summary)
  --json <file>       also write a JSON report
  --sarif <file>      also write SARIF for GitHub code scanning
  --fail-on <level>   exit 1 on: breaking (default), warning, never
  --all               list non-breaking changes too (text format)
  --no-color          plain output (also when NO_COLOR is set)
  -v, --version
  -h, --help

Exit codes: 0 no failing changes, 1 failing changes found, 2 contractwatch couldn't run.
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      format: { type: 'string', default: 'text' },
      markdown: { type: 'string' },
      json: { type: 'string' },
      sarif: { type: 'string' },
      'fail-on': { type: 'string', default: 'breaking' },
      all: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.version) return void console.log(VERSION), 0;
  const [command, ...files] = positionals;
  if (values.help || !command) return void console.log(HELP), 0;
  if (command !== 'diff') return usage(`unknown command "${command}"`);
  if (!['text', 'markdown', 'json'].includes(values.format)) return usage(`--format must be text, markdown or json`);
  const failOn = values['fail-on'];
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

  const result = diffSpecs(base, head);
  const color = !values['no-color'] && !process.env.NO_COLOR && process.stdout.isTTY === true;
  const json = () => JSON.stringify({ ...result, summary: counts(result) }, null, 2) + '\n';
  const stdout = values.format === 'json' ? json() : values.format === 'markdown' ? renderMarkdown(result) : renderText(result, { color, all: values.all });
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

function usage(message: string): number {
  console.error(`contractwatch: ${message}\nRun \`contractwatch --help\` for usage.`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    if (err instanceof SpecLoadError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) console.error(`contractwatch: ${(err as Error).message}`);
    else console.error(err);
    process.exitCode = 2;
  },
);

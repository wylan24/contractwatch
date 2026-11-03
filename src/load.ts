import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { parse as parseYaml } from 'yaml';
import type { Spec } from './types.ts';

export class SpecLoadError extends Error {
  readonly file: string;

  constructor(message: string, file: string) {
    super(`${file}: ${message}`);
    this.name = 'SpecLoadError';
    this.file = file;
  }
}

/** The spec file exists in the working tree but not at the base ref: a brand-new API, nothing to compare. */
export class NotAtRefError extends SpecLoadError {}

const display = (abs: string) => path.relative(process.cwd(), abs).split(path.sep).join('/') || abs;

/** Load an OpenAPI 3.x file from disk (YAML or JSON, multi-file `$ref`s allowed). */
export function loadSpec(file: string): Promise<Spec> {
  const abs = path.resolve(file);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    throw new SpecLoadError('no such file', display(abs));
  }
  return build(abs, text, 'working tree', (p) => readFileSync(p, 'utf8'));
}

/**
 * Load the spec as it was at a git ref (`origin/main`, a commit SHA…). Relative `$ref`s are read at the
 * same ref, so a multi-file spec is compared as a whole rather than mixing old and new files.
 */
export function loadSpecAtRef(file: string, ref: string): Promise<Spec> {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  let root: string;
  try {
    root = git(dir, 'rev-parse', '--show-toplevel').trim();
  } catch {
    throw new SpecLoadError(`not inside a git repository, so --base ${ref} can't be read`, display(abs));
  }
  const show = (p: string) => {
    const rel = path.relative(path.resolve(root), p).split(path.sep).join('/');
    return git(root, 'show', `${ref}:${rel}`);
  };
  let text: string;
  try {
    text = show(abs);
  } catch (err) {
    const msg = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    if (/does not exist|exists on disk, but not in/.test(msg)) throw new NotAtRefError(`not present at ${ref}`, display(abs));
    throw new SpecLoadError(`can't read it at ${ref}: ${msg.trim() || (err as Error).message}`, display(abs));
  }
  return build(abs, text, ref, show);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

async function build(abs: string, text: string, source: string, read: (absPath: string) => string): Promise<Spec> {
  const file = display(abs);
  let raw: any;
  try {
    raw = parseYaml(text, { merge: true, maxAliasCount: -1 });
  } catch (err) {
    throw new SpecLoadError(`not valid YAML or JSON: ${(err as Error).message.split('\n')[0]}`, file);
  }
  if (raw?.swagger) throw new SpecLoadError(`Swagger ${raw.swagger} is not supported; convert it to OpenAPI 3 first (e.g. with swagger2openapi).`, file);
  if (typeof raw?.openapi !== 'string' || !raw.openapi.startsWith('3.')) {
    throw new SpecLoadError('not an OpenAPI 3.x document (missing or unsupported `openapi` field).', file);
  }

  let doc: any;
  try {
    doc = await new $RefParser().dereference(abs, raw, {
      resolve: {
        file: {
          order: 1,
          canRead: (f: { url: string }) => !/^https?:/i.test(f.url),
          read: (f: { url: string }) => read(toPath(f.url)),
        },
      },
      // Circular refs stay as object cycles; the schema diff tracks visited pairs.
      dereference: { circular: true },
    } as any);
  } catch (err) {
    throw new SpecLoadError((err as Error).message, file);
  }

  return { file, source, openapi: raw.openapi, title: raw.info?.title ?? '', version: String(raw.info?.version ?? ''), doc, text };
}

/** The ref parser hands resolvers `file://` URLs or plain paths, depending on platform. */
function toPath(url: string): string {
  if (/^file:/i.test(url)) return fileURLToPath(url.split('#')[0]);
  return path.resolve(decodeURIComponent(url.split('#')[0]));
}

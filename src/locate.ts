import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Document, isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml';

interface Loaded {
  doc: Document;
  lines: LineCounter;
}

/**
 * Line numbers for changes. Pointers are logical (as if `$ref`s were inlined), so walking the raw document
 * follows `$ref`s, local and into other files: a property of a shared schema is reported where the schema
 * defines it. When the pointer leads somewhere that no longer exists (a removal), the deepest part that
 * does is used.
 */
export class Locator {
  private files = new Map<string, Loaded | null>();
  private root: string;
  private read: (abs: string) => string;

  /**
   * @param root absolute path of the spec's root file
   * @param text its contents (already read, possibly from a git ref)
   * @param read reads another file of the spec; defaults to the disk
   */
  constructor(root: string, text: string, read: (abs: string) => string = (abs) => readFileSync(abs, 'utf8')) {
    this.root = root;
    this.read = read;
    this.files.set(root, parse(text));
  }

  line(pointer: string[]): number {
    return this.locate(pointer).line;
  }

  locate(pointer: string[]): { file: string; line: number } {
    let file = this.root;
    let node: Node | null | undefined = this.files.get(file)?.doc.contents;
    let line = 1;
    const seen = new Set<Node>();
    for (const seg of pointer) {
      const hop = this.follow(file, node, seen);
      if (hop.file !== file) line = 1;
      file = hop.file;
      node = hop.node;
      const next = this.child(file, node, seg);
      if (!next) break;
      line = next.line;
      node = next.node;
    }
    return { file, line };
  }

  private load(file: string): Loaded | undefined {
    if (!this.files.has(file)) {
      try {
        this.files.set(file, parse(this.read(file)));
      } catch {
        this.files.set(file, null);
      }
    }
    return this.files.get(file) ?? undefined;
  }

  /** Jump through `$ref`s: `#/components/schemas/Pet`, `./user.yaml`, `models.yaml#/Team`. */
  private follow(file: string, node: Node | null | undefined, seen: Set<Node>): { file: string; node: Node | null | undefined } {
    while (isMap(node) && !seen.has(node)) {
      seen.add(node);
      const ref = node.get('$ref');
      if (typeof ref !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(ref)) break;
      const [target, fragment = ''] = ref.split('#');
      const nextFile = target ? path.resolve(path.dirname(file), decodeURIComponent(target)) : file;
      const loaded = this.load(nextFile);
      if (!loaded) break;
      const segs = fragment.split('/').filter(Boolean).map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));
      const found = (segs.length ? loaded.doc.getIn(segs, true) : loaded.doc.contents) as Node | undefined;
      if (!found) break;
      file = nextFile;
      node = found;
    }
    return { file, node };
  }

  private child(file: string, node: Node | null | undefined, seg: string): { node: Node | null; line: number } | undefined {
    const lines = this.files.get(file)!.lines;
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) return undefined;
      const range = (pair.key as Node).range;
      return { node: pair.value as Node | null, line: range ? lines.linePos(range[0]).line : 1 };
    }
    if (isSeq(node)) {
      const item = node.items[Number(seg)] as Node | undefined;
      if (!item?.range) return undefined;
      return { node: item, line: lines.linePos(item.range[0]).line };
    }
    return undefined;
  }
}

function parse(text: string): Loaded {
  const lines = new LineCounter();
  return { doc: parseDocument(text, { lineCounter: lines, merge: true }), lines };
}

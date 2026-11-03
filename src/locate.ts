import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml';

/**
 * Line numbers for changes. Pointers are logical (as if `$ref`s were inlined), so walking the raw document
 * follows local `$ref`s: a property of a shared component is reported where the component defines it.
 * When the pointer leads somewhere that no longer exists (a removal), the deepest part that does is used.
 */
export class Locator {
  private doc;
  private lines = new LineCounter();

  constructor(text: string) {
    this.doc = parseDocument(text, { lineCounter: this.lines, merge: true });
  }

  line(pointer: string[]): number {
    let node: Node | null | undefined = this.doc.contents;
    let line = 1;
    const seen = new Set<Node>();
    for (const seg of pointer) {
      node = this.follow(node, seen);
      const next = this.child(node, seg);
      if (!next) break;
      line = next.line;
      node = next.node;
    }
    return line;
  }

  /** Jump through a local `$ref` (`#/components/schemas/Pet`). External ones stay put. */
  private follow(node: Node | null | undefined, seen: Set<Node>): Node | null | undefined {
    while (isMap(node) && !seen.has(node)) {
      seen.add(node);
      const ref = node.get('$ref');
      if (typeof ref !== 'string' || !ref.startsWith('#/')) break;
      const path = ref.slice(2).split('/').map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));
      const target = this.doc.getIn(path, true) as Node | undefined;
      if (!target) break;
      node = target;
    }
    return node;
  }

  private child(node: Node | null | undefined, seg: string): { node: Node | null; line: number } | undefined {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === seg);
      if (!pair) return undefined;
      const range = (pair.key as Node).range;
      return { node: pair.value as Node | null, line: range ? this.lines.linePos(range[0]).line : 1 };
    }
    if (isSeq(node)) {
      const item = node.items[Number(seg)] as Node | undefined;
      if (!item?.range) return undefined;
      return { node: item, line: this.lines.linePos(item.range[0]).line };
    }
    return undefined;
  }
}

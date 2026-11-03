// Shared types: a loaded spec, and the changes found between two of them.

/** An OpenAPI / JSON Schema schema object, already dereferenced. May contain cycles. */
export type Schema = Record<string, any>;

export type Severity = 'breaking' | 'warning' | 'info';
export const SEVERITIES: Severity[] = ['breaking', 'warning', 'info'];

/** Whether data flows from the client (request) or to it (response). Decides which edits break clients. */
export type Direction = 'request' | 'response';

export interface Change {
  /** Short stable id for this change, used to accept it in `.contractwatch.json`. */
  id: string;
  /** Rule id from `rules.ts`, e.g. `property-removed`. */
  rule: string;
  severity: Severity;
  /** `GET /pets/{id}`, or undefined for document-level changes. */
  operation?: string;
  direction?: Direction;
  /** Human-readable location inside the operation, e.g. `response 200 body: tags[].name`. */
  where?: string;
  message: string;
  /**
   * JSON pointer segments into the head spec (logical, i.e. as if `$ref`s were inlined). For removals it
   * points at where the thing was; `locate` falls back to the deepest part that still exists.
   */
  pointer: string[];
  /** Why this change doesn't fail the check, when it was accepted (by id or by a major version bump). */
  accepted?: string;
}

/** A change before its id is assigned. */
export type RawChange = Omit<Change, 'id' | 'accepted'>;

export interface Spec {
  /** Path shown to users, relative to the working directory. */
  file: string;
  /** Where the spec came from: `working tree`, a git ref, or a file path. */
  source: string;
  openapi: string;
  title: string;
  version: string;
  /** The dereferenced document. */
  doc: any;
  /** Raw text of the root file, for line numbers. */
  text: string;
}

export interface DiffResult {
  base: Pick<Spec, 'file' | 'source' | 'title' | 'version' | 'openapi'>;
  head: Pick<Spec, 'file' | 'source' | 'title' | 'version' | 'openapi'>;
  changes: Change[];
  /** Messages about the configuration, e.g. an acceptance that expired. */
  notes: string[];
}

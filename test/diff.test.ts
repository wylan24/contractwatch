import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { diffSpecs } from '../src/diff.ts';
import { loadSpec } from '../src/load.ts';
import type { Change, Spec } from '../src/types.ts';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** A spec from an in-memory document (no `$ref`s), for focused rule tests. */
function spec(doc: any): Spec {
  return { file: 'openapi.yaml', source: 'test', openapi: doc.openapi ?? '3.1.0', title: '', version: '', doc, text: '' };
}

/** One operation whose request or response body is `schema`. */
function bodyDoc(schema: any, where: 'request' | 'response') {
  const media = { content: { 'application/json': { schema } } };
  const op = where === 'request' ? { requestBody: media, responses: { '204': { description: '' } } } : { responses: { '200': { description: '', ...media } } };
  return { openapi: '3.1.0', paths: { '/x': { post: op } } };
}

function diffBody(base: any, head: any, where: 'request' | 'response'): Change[] {
  return diffSpecs(spec(bodyDoc(base, where)), spec(bodyDoc(head, where))).changes;
}

const rules = (changes: Change[]) => changes.map((c) => `${c.rule}:${c.severity}`).sort();

describe('petstore fixture', async () => {
  const result = diffSpecs(await loadSpec(fixture('petstore-base.yaml')), await loadSpec(fixture('petstore-head.yaml')));
  const has = (rule: string, op?: string) => result.changes.some((c) => c.rule === rule && (!op || c.operation === op));

  test('finds the headline breaking changes', () => {
    assert.ok(has('operation-removed', 'DELETE /pets/{id}'));
    assert.ok(has('required-parameter-added', 'GET /pets'));
    assert.ok(has('request-body-became-required', 'POST /pets'));
    assert.ok(has('required-property-added', 'POST /pets'));
    assert.ok(has('enum-value-removed', 'POST /pets'));
    assert.ok(has('property-removed', 'GET /pets'));
    assert.ok(has('security-added', 'POST /pets'));
  });

  test('renaming a path parameter is not a removal', () => {
    assert.ok(!has('operation-removed', 'GET /pets/{petId}'));
    assert.ok(!has('operation-added', 'GET /pets/{petId}'));
    assert.ok(has('operation-deprecated', 'GET /pets/{petId}'));
  });

  test('an operation that opts out with `security: []` stays public', () => {
    assert.ok(!has('security-added', 'GET /pets'));
  });

  test('additive changes are not breaking', () => {
    for (const c of result.changes.filter((c) => ['operation-added', 'property-added', 'error-response-removed'].includes(c.rule))) {
      assert.equal(c.severity, 'info', c.message);
    }
  });

  test('follows the Pet ↔ Owner cycle without looping', () => {
    assert.ok(result.changes.length < 100);
  });
});

describe('direction', () => {
  const obj = (props: any, required: string[] = []) => ({ type: 'object', properties: props, required });

  test('removing a property breaks responses but not requests', () => {
    const base = obj({ a: { type: 'string' }, b: { type: 'string' } });
    const head = obj({ a: { type: 'string' } });
    assert.deepEqual(rules(diffBody(base, head, 'response')), ['property-removed:breaking']);
    assert.deepEqual(rules(diffBody(base, head, 'request')), ['property-removed:warning']);
  });

  test('removing a property from a closed request object is breaking', () => {
    const base = obj({ a: { type: 'string' }, b: { type: 'string' } });
    const head = { ...obj({ a: { type: 'string' } }), additionalProperties: false };
    assert.ok(rules(diffBody(base, head, 'request')).includes('property-removed-closed:breaking'));
  });

  test('a new required property breaks requests but not responses', () => {
    const base = obj({ a: { type: 'string' } });
    const head = obj({ a: { type: 'string' }, b: { type: 'string' } }, ['b']);
    assert.deepEqual(rules(diffBody(base, head, 'request')), ['required-property-added:breaking']);
    assert.deepEqual(rules(diffBody(base, head, 'response')), ['required-property-added:info']);
  });

  test('enum values: added warns in responses, removed breaks requests', () => {
    const base = { type: 'string', enum: ['a', 'b'] };
    const head = { type: 'string', enum: ['b', 'c'] };
    assert.deepEqual(rules(diffBody(base, head, 'response')), ['enum-value-added:warning', 'enum-value-removed:info']);
    assert.deepEqual(rules(diffBody(base, head, 'request')), ['enum-value-added:info', 'enum-value-removed:breaking']);
  });

  test('integer → number widens: fine to accept, breaking to return', () => {
    assert.deepEqual(rules(diffBody({ type: 'integer' }, { type: 'number' }, 'request')), ['type-widened:info']);
    assert.deepEqual(rules(diffBody({ type: 'integer' }, { type: 'number' }, 'response')), ['type-widened:breaking']);
    assert.deepEqual(rules(diffBody({ type: 'string' }, { type: 'integer' }, 'request')), ['type-changed:breaking']);
  });

  test('nullability: 3.0 `nullable` and 3.1 type arrays compare equal', () => {
    assert.deepEqual(diffBody({ type: 'string', nullable: true }, { type: ['string', 'null'] }, 'response'), []);
    assert.deepEqual(rules(diffBody({ type: 'string' }, { type: ['string', 'null'] }, 'response')), ['became-nullable:breaking']);
    assert.deepEqual(rules(diffBody({ type: 'string', nullable: true }, { type: 'string' }, 'request')), ['no-longer-nullable:breaking']);
  });

  test('limits: tightening breaks requests, loosening warns in responses', () => {
    assert.deepEqual(rules(diffBody({ type: 'string', maxLength: 10 }, { type: 'string', maxLength: 5 }, 'request')), ['constraint-tightened:breaking']);
    assert.deepEqual(rules(diffBody({ type: 'string', maxLength: 10 }, { type: 'string' }, 'response')), ['constraint-loosened:warning']);
  });

  test('readOnly properties are ignored in requests, writeOnly in responses', () => {
    const base = obj({ id: { type: 'string', readOnly: true }, pw: { type: 'string', writeOnly: true } });
    const head = obj({});
    assert.deepEqual(rules(diffBody(base, head, 'request')), ['property-removed:warning']);
    assert.deepEqual(rules(diffBody(base, head, 'response')), ['property-removed:breaking']);
    assert.match(diffBody(base, head, 'request')[0].message, /pw/);
    assert.match(diffBody(base, head, 'response')[0].message, /id/);
  });

  test('moving properties into allOf is not a change', () => {
    const base = obj({ a: { type: 'string' }, b: { type: 'integer' } }, ['a']);
    const head = { allOf: [obj({ a: { type: 'string' } }, ['a']), obj({ b: { type: 'integer' } })] };
    assert.deepEqual(diffBody(base, head, 'response'), []);
  });

  test('oneOf variants are matched by shape, not position', () => {
    const cat = obj({ meow: { type: 'boolean' } });
    const dog = obj({ bark: { type: 'boolean' } });
    const fish = obj({ fins: { type: 'integer' } });
    assert.deepEqual(diffBody({ oneOf: [cat, dog] }, { oneOf: [dog, cat] }, 'response'), []);
    assert.deepEqual(rules(diffBody({ oneOf: [cat, dog] }, { oneOf: [cat, fish, dog] }, 'response')), ['variant-added:warning']);
    assert.deepEqual(rules(diffBody({ oneOf: [cat, dog] }, { oneOf: [dog] }, 'request')), ['variant-removed:breaking']);
  });

  test('nested arrays name the field path', () => {
    const base = obj({ tags: { type: 'array', items: obj({ name: { type: 'string' } }) } });
    const head = obj({ tags: { type: 'array', items: obj({}) } });
    assert.match(diffBody(base, head, 'response')[0].message, /`tags\[\]\.name` was removed/);
  });
});

describe('operations', () => {
  const op = (o: any) => ({ openapi: '3.1.0', paths: { '/x': { get: { responses: { '200': { description: '' } }, ...o } } } });

  test('parameters: required vs optional, header names are case-insensitive', () => {
    const base = op({ parameters: [{ name: 'X-Trace', in: 'header', schema: { type: 'string' } }] });
    const head = op({ parameters: [{ name: 'x-trace', in: 'header', required: true, schema: { type: 'string' } }, { name: 'q', in: 'query' }] });
    assert.deepEqual(rules(diffSpecs(spec(base), spec(head)).changes), ['parameter-added:info', 'parameter-became-required:breaking']);
  });

  test('responses: removing a success code breaks, removing an error code does not', () => {
    const base = op({ responses: { '200': { description: '' }, '400': { description: '' } } });
    const head = op({ responses: { '201': { description: '' } } });
    assert.deepEqual(rules(diffSpecs(spec(base), spec(head)).changes), ['error-response-removed:info', 'response-added:info', 'success-response-removed:breaking']);
  });

  test('media types compare without parameters', () => {
    const res = (type: string) => op({ responses: { '200': { description: '', content: { [type]: { schema: { type: 'string' } } } } } });
    assert.deepEqual(diffSpecs(spec(res('application/json')), spec(res('application/json; charset=utf-8'))).changes, []);
    assert.deepEqual(rules(diffSpecs(spec(res('application/json')), spec(res('text/plain'))).changes), ['response-media-type-added:info', 'response-media-type-removed:breaking']);
  });

  test('identical specs have no changes', async () => {
    const s = await loadSpec(fixture('petstore-base.yaml'));
    assert.deepEqual(diffSpecs(s, await loadSpec(fixture('petstore-base.yaml'))).changes, []);
  });
});

test('multi-file specs resolve external $refs', async () => {
  const result = diffSpecs(await loadSpec(fixture('multi-base/openapi.yaml')), await loadSpec(fixture('multi-head/openapi.yaml')));
  assert.deepEqual(rules(result.changes), ['became-nullable:breaking', 'property-became-optional:breaking']);
});

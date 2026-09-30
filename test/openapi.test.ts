import assert from 'node:assert/strict';
import { test } from 'node:test';
import mint from './fixtures/mint-key.json' with { type: 'json' };
import spec from './fixtures/openapi.json' with { type: 'json' };
import pay from './fixtures/pay-402.json' with { type: 'json' };

type Schema = { required?: string[]; properties?: Record<string, Schema>; items?: Schema };

/**
 * The fields `schema` requires that `value` lacks, as paths.
 * ponytail: required fields only, no types, $ref or oneOf; the published
 * schemas are inline. Use a JSON Schema validator if they grow those.
 */
function missing(schema: Schema, value: unknown, at = '$'): string[] {
  if (Array.isArray(value)) return schema.items ? value.flatMap((v, i) => missing(schema.items!, v, `${at}[${i}]`)) : [];
  if (value === null || typeof value !== 'object') return [];
  const fields = value as Record<string, unknown>;
  return [
    ...(schema.required ?? []).filter((name) => !(name in fields)).map((name) => `${at}.${name}`),
    ...Object.entries(schema.properties ?? {}).flatMap(([name, s]) => (name in fields ? missing(s, fields[name], `${at}.${name}`) : [])),
  ];
}

const paths = spec.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>;
const answer = (path: string, method: string, status: number) => paths[path][method].responses[status].content['application/json'].schema;

test('the recorded answers carry every field the published OpenAPI document requires', () => {
  assert.deepEqual(missing(answer('/api/api-keys', 'post', 201), mint[2].body), []);
  assert.deepEqual(missing(answer('/v1/chat/completions', 'post', 402), pay.http[0].body), []);
  assert.deepEqual(missing(answer('/v1/chat/completions', 'post', 200), pay.http[1].body), []);
});

test('the published 402 requires every field the SDK reads to pay it', () => {
  const accept = answer('/v1/chat/completions', 'post', 402).properties!.error.properties!.accepts.items!;
  assert.deepEqual(
    [accept.required, accept.properties!.instruction.required].map((r) => [...(r ?? [])].sort()),
    [
      ['chain_id', 'delegate', 'instruction', 'payer', 'scheme'],
      ['args', 'contract', 'function', 'minimum_value_wei'],
    ],
  );
});

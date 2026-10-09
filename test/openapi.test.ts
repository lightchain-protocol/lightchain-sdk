import assert from 'node:assert/strict';
import { test } from 'node:test';
import vectors from './fixtures/x402-vectors.json' with { type: 'json' };
// The consumer API's published document; `npm run openapi` writes it from ../consumer-api.
import spec from './fixtures/openapi.json' with { type: 'json' };
import pay from './fixtures/pay-402.json' with { type: 'json' };

type Schema = { required?: string[]; properties?: Record<string, Schema>; items?: Schema; oneOf?: Schema[]; enum?: string[] };

/**
 * The fields `schema` requires that `value` lacks, as paths. A oneOf takes
 * the branch that misses least.
 * ponytail: required fields only, no types or $ref; the published schemas are
 * inline. Use a JSON Schema validator if they grow those.
 */
function missing(schema: Schema, value: unknown, at = '$'): string[] {
  if (schema.oneOf) return schema.oneOf.map((s) => missing(s, value, at)).reduce((a, b) => (b.length < a.length ? b : a));
  if (Array.isArray(value)) return schema.items ? value.flatMap((v, i) => missing(schema.items!, v, `${at}[${i}]`)) : [];
  if (value === null || typeof value !== 'object') return [];
  const fields = value as Record<string, unknown>;
  return [
    ...(schema.required ?? []).filter((name) => !(name in fields)).map((name) => `${at}.${name}`),
    ...Object.entries(schema.properties ?? {}).flatMap(([name, s]) => (name in fields ? missing(s, fields[name], `${at}.${name}`) : [])),
  ];
}

type Response = { headers?: Record<string, unknown>; content: Record<string, { schema: Schema }> };
type Operation = { parameters: { in: string; name: string }[]; responses: Record<string, Response> };
const completions = (spec.paths as unknown as Record<string, Record<string, Operation>>)['/v1/chat/completions'].post;
const answer = (status: number) => completions.responses[status].content['application/json'].schema;

/** The published `accepts` entry of a payment scheme. */
function offer(scheme: string): Schema {
  const entry = answer(402).properties!.error.properties!.accepts.items!.oneOf!.find((s) => s.properties!.scheme.enum!.includes(scheme));
  assert.ok(entry, `the published 402 offers no ${scheme} entry`);
  return entry;
}

const sortedRequired = (...schemas: Schema[]) => schemas.map((s) => [...(s.required ?? [])].sort());

test('the recorded answers and the scheme vectors carry every field the published OpenAPI document requires', () => {
  assert.deepEqual(missing(answer(402), pay.http[0].body), []);
  assert.deepEqual(missing(answer(200), pay.http[1].body), []);
  for (const v of vectors.vectors) assert.deepEqual(missing(offer('prepaid-debit'), v.paymentRequirements), [], v.name);
});

test('the published 402 requires every field the SDK reads to pay it, in either scheme', () => {
  assert.ok(answer(402).properties!.error.required!.includes('message'));
  const delegate = offer('delegate');
  assert.deepEqual(sortedRequired(delegate, delegate.properties!.instruction), [
    ['chain_id', 'delegate', 'instruction', 'payer', 'scheme'],
    ['args', 'contract', 'function', 'minimum_value_wei'],
  ]);
  const prepaid = offer('prepaid-debit');
  assert.deepEqual(sortedRequired(prepaid, prepaid.properties!.extra), [
    ['amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme'],
    ['facilitatorAddress', 'name', 'version'],
  ]);
});

test('the published completion takes PAYMENT-SIGNATURE and answers with the x402 headers', () => {
  assert.ok(completions.parameters.some((p) => p.in === 'header' && p.name === 'payment-signature'));
  for (const [status, header] of [
    [402, 'payment-required'],
    [402, 'payment-response'],
    [200, 'payment-response'],
  ] as const) {
    assert.ok(header in (completions.responses[status].headers ?? {}), `${status} has no ${header} header`);
  }
});

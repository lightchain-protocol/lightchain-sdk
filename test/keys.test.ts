import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAI from 'openai';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, type LightchainOptions } from '../src/index.ts';
import devnet from './fixtures/devnet.json' with { type: 'json' };
import pay from './fixtures/pay-402.json' with { type: 'json' };
import { type Exchange, replayHttp, replayRpc } from './replay.ts';

const network = devnet.network as Lightchain['network'];
const account = privateKeyToAccount(devnet.privateKey as Hex);
const [paymentRequired, completed] = pay.http as [Exchange, Exchange];

test('a client with only an API key completes through the OpenAI SDK', async () => {
  const http = replayHttp([completed]);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, fetch: http.fetch });
  const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: lc.apiKey, fetch: lc.fetch });

  const completion = await openai.chat.completions.create({
    model: 'llama3-8b',
    messages: [{ role: 'user', content: 'Say hello in five words.' }],
  });

  assert.equal(completion.choices[0].message.content, 'Hello, how are you today?');
  assert.equal(http.sent[0].path, '/v1/chat/completions');
  assert.equal(http.sent[0].headers.get('authorization'), `Bearer ${devnet.apiKey}`);
  http.done();
});

test('without an account, hands back the 402 of an unpaid wallet as it is, sending nothing', async () => {
  const http = replayHttp([paymentRequired]);
  const rpc = replayRpc([]);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, fetch: http.fetch, transport: rpc.transport });

  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, { method: 'POST', body: '{}' });

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), paymentRequired.body);
  assert.deepEqual(rpc.sent, []);
  assert.equal(http.sent[0].headers.get('authorization'), `Bearer ${devnet.apiKey}`, 'fetch sends the key by itself');
  http.done();
});

const perCall = { payment: 'per-call', maxPaymentWei: 1n } as const;
const misconfigured: [string, object, RegExp][] = [
  ['the delegate mode with no API key', { account }, /needs apiKey/],
  ['an empty API key', { apiKey: '' }, /needs apiKey/],
  ['depositWei with no account to deposit from', { apiKey: 'lcai_x', depositWei: 1n }, /need account/],
  ['onDeposit with no account to deposit from', { apiKey: 'lcai_x', onDeposit: () => {} }, /need account/],
  ['per-call with no account to sign', { ...perCall, apiKey: 'lcai_x' }, /payment "per-call" needs account/],
];
for (const [what, options, reason] of misconfigured) {
  test(`refuses ${what}`, () => {
    assert.throws(() => new Lightchain({ network, ...options } as LightchainOptions), reason);
  });
}

test('sends no transaction and reads no balance without an account', async () => {
  const rpc = replayRpc([]);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, transport: rpc.transport });

  await assert.rejects(lc.deposit(1n), /deposit needs account/);
  await assert.rejects(lc.depositAndAuthorize(account.address, 1n), /depositAndAuthorize needs account/);
  await assert.rejects(lc.getBalance(), /getBalance needs account/);
  assert.deepEqual(rpc.sent, []);
});

test("sends the key to the network's API only", async () => {
  const sent: (string | null)[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Request(input, init).headers.get('authorization'));
    return new Response('{}');
  };
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, fetch });

  await lc.fetch('http://localhost:8091/v1/models');
  await lc.fetch('https://example.com/v1/models', { headers: { authorization: 'Bearer theirs' } });
  await lc.fetch(`${lc.baseURL}/models`);

  assert.deepEqual(sent, [null, 'Bearer theirs', `Bearer ${devnet.apiKey}`]);
});

test('keeps the key out of what a logged client prints', () => {
  const lc = new Lightchain({ network, apiKey: devnet.apiKey });
  assert.equal(lc.apiKey, devnet.apiKey);
  assert.doesNotMatch(JSON.stringify(lc), /lcai_/);
});

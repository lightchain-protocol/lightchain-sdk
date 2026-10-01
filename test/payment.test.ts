import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, type Hex, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { jobRegistryAbi, Lightchain } from '../src/index.ts';
import devnet from './fixtures/devnet.json' with { type: 'json' };
import pay from './fixtures/pay-402.json' with { type: 'json' };
import spendCap from './fixtures/spend-cap-402.json' with { type: 'json' };
import { type Exchange, replayHttp, replayRpc } from './replay.ts';

const account = privateKeyToAccount(devnet.privateKey as Hex);
const network = devnet.network as Lightchain['network'];
const [paymentRequired, completed] = pay.http as [Exchange, Exchange];
const [offer] = (paymentRequired.body as { error: { accepts: Accept[] } }).error.accepts;
type Accept = { delegate: Hex; instruction: { contract: Hex; minimum_value_wei: string } };
const minimum = BigInt(offer.instruction.minimum_value_wei);

const request = {
  method: 'POST',
  headers: { authorization: `Bearer ${devnet.apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'llama3-8b', messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
};

/** The transactions the SDK sent, decoded. */
function sentTransactions(sent: { method: string; params: unknown }[]) {
  return sent
    .filter((call) => call.method === 'eth_sendRawTransaction')
    .map((call) => {
      const tx = parseTransaction((call.params as [Hex])[0]);
      return { to: tx.to, value: tx.value, call: decodeFunctionData({ abi: jobRegistryAbi, data: tx.data as Hex }) };
    });
}

/** The same 402 with `accepts` replaced. */
function withAccepts(accepts: object[]): Exchange {
  const body = paymentRequired.body as { error: { accepts: Accept[] } };
  return { ...paymentRequired, body: { error: { ...body.error, accepts } } };
}
const withOffer = (change: (accept: Accept) => object) => withAccepts([change(offer)]);

// The x402 prepaid-debit requirements an API that takes x402 payments lists
// after the delegate entry, shaped as consumer-api's own tests build them.
const prepaidDebit = {
  scheme: 'prepaid-debit',
  network: `eip155:${network.chainId}`,
  amount: offer.instruction.minimum_value_wei,
  asset: network.jobRegistry,
  payTo: offer.delegate,
  maxTimeoutSeconds: 120,
  extra: { name: 'LightChain JobRegistry', version: '1', facilitatorAddress: '0x976EA74026E726554dB657fA54763abd0C3a0aa9' },
};

test('pays a 402 with the depositAndAuthorize it names, then sends the request again', async () => {
  const http = replayHttp(pay.http as Exchange[]);
  const rpc = replayRpc(pay.rpc);
  const deposits: unknown[] = [];
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, fetch: http.fetch, transport: rpc.transport, onDeposit: (d) => deposits.push(d) });

  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completed.body);
  assert.deepEqual(sentTransactions(rpc.sent), [
    { to: network.jobRegistry.toLowerCase(), value: minimum, call: { functionName: 'depositAndAuthorize', args: [offer.delegate] } },
  ]);
  const hash = pay.rpc.find((call) => call.method === 'eth_sendRawTransaction')?.result;
  assert.deepEqual(deposits, [{ hash, value: minimum, delegate: offer.delegate }]);
  assert.deepEqual(http.sent[1].body, http.sent[0].body, 'the retry sends the same request');
  assert.equal(http.sent[1].headers.get('authorization'), `Bearer ${devnet.apiKey}`, 'with the key');
  http.done();
});

test('deposits depositWei when it is above the minimum', async () => {
  const http = replayHttp(pay.http as Exchange[]);
  const rpc = replayRpc(pay.rpc);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, fetch: http.fetch, transport: rpc.transport, depositWei: minimum * 10n });

  await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.equal(sentTransactions(rpc.sent)[0].value, minimum * 10n);
});

test('pays each of 402s that arrive together, one deposit after the other', async () => {
  const http = replayHttp([paymentRequired, paymentRequired, completed, completed]);
  const rpc = replayRpc(pay.rpc);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, fetch: http.fetch, transport: rpc.transport });

  const url = `${lc.baseURL}/chat/completions`;
  const responses = await Promise.all([lc.fetch(url, request), lc.fetch(url, request)]);

  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  // Each deposit covers its own retry: one deposit of one job's fee would pay one of them.
  assert.equal(sentTransactions(rpc.sent).length, 2);
  const methods = rpc.sent.map((c) => c.method);
  const first = methods.indexOf('eth_sendRawTransaction');
  const second = methods.indexOf('eth_sendRawTransaction', first + 1);
  assert.ok(methods.slice(first, second).includes('eth_getTransactionReceipt'), 'the second deposit waits for the first');
});

for (const [order, accepts] of [
  ['before', [offer, prepaidDebit]],
  ['after', [prepaidDebit, offer]],
] as const) {
  test(`pays the delegate entry listed ${order} an x402 entry, leaving the x402 one alone`, async () => {
    const http = replayHttp([withAccepts([...accepts]), completed]);
    const rpc = replayRpc(pay.rpc);
    const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, fetch: http.fetch, transport: rpc.transport, payment: 'delegate' });

    const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

    assert.equal(response.status, 200);
    assert.deepEqual(sentTransactions(rpc.sent), [
      { to: network.jobRegistry.toLowerCase(), value: minimum, call: { functionName: 'depositAndAuthorize', args: [offer.delegate] } },
    ]);
    assert.equal(http.sent[1].headers.get('payment-signature'), null, 'the delegate mode signs no x402 payment');
  });
}

test('hands back a 402 that is not a missing payment, sending nothing', async () => {
  const http = replayHttp(spendCap as Exchange[]);
  const rpc = replayRpc([]);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, fetch: http.fetch, transport: rpc.transport });

  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), spendCap[0].body);
  assert.equal(rpc.sent.length, 0);
});

const refusals: [string, Exchange, RegExp, bigint?][] = [
  ['names a contract other than the JobRegistry', withOffer((a) => ({ ...a, instruction: { ...a.instruction, contract: '0x000000000000000000000000000000000000dEaD' } })), /JobRegistry/],
  ['is for another chain', withOffer((a) => ({ ...a, chain_id: 1 })), /chain 1/],
  ['is for another wallet', withOffer((a) => ({ ...a, payer: '0x000000000000000000000000000000000000dEaD' })), /another wallet/],
  ['asks for more than depositWei', paymentRequired, /more than depositWei/, minimum - 1n],
];
for (const [what, answer, reason, depositWei] of refusals) {
  test(`does not pay a 402 that ${what}, and says why`, async () => {
    const http = replayHttp([answer]);
    const rpc = replayRpc([]);
    const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, fetch: http.fetch, transport: rpc.transport, depositWei });

    const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

    assert.equal(response.status, 402);
    const { error } = (await response.json()) as { error: { message: string; code: string } };
    assert.match(error.message, reason);
    assert.equal(error.code, (paymentRequired.body as { error: { code: string } }).error.code);
    assert.equal(rpc.sent.length, 0);
  });
}

test('deposits into the prepaid balance alone, authorizing no delegate: what x402 pays from', async () => {
  const rpc = replayRpc(pay.rpc);
  const lc = new Lightchain({ network, apiKey: devnet.apiKey, account, transport: rpc.transport });

  const hash = await lc.deposit(minimum * 5n);

  assert.equal(hash, pay.rpc.find((call) => call.method === 'eth_sendRawTransaction')?.result);
  assert.deepEqual(sentTransactions(rpc.sent), [
    { to: network.jobRegistry.toLowerCase(), value: minimum * 5n, call: { functionName: 'deposit', args: undefined } },
  ]);
});

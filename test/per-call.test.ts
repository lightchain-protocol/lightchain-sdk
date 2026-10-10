import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { type Hex, hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, type LightchainOptions, networks, type Payment } from '../src/index.ts';
import vectors from './fixtures/x402-vectors.json' with { type: 'json' };
import pay from './fixtures/pay-402.json' with { type: 'json' };
import { type Exchange, replayHttp, replayRpc } from './replay.ts';

// The prepaid-debit scheme's test vectors:
// their payer is Foundry's public test account 3, never a key for a real network.
type Vector = (typeof vectors.vectors)[number];
const payerKey = vectors.accounts.find((a) => a.role === 'payer')!.privateKey as Hex;
const vector = (name: string) => vectors.vectors.find((v) => v.name === name) as Vector;

const [delegateRequired, completed] = pay.http as [Exchange, Exchange];
const [delegateOffer] = (delegateRequired.body as { error: { accepts: object[] } }).error.accepts;

/** The Developer API's 402 for a wallet with no delegate: the delegate entry, then the x402 requirements. */
function paymentRequired(requirements: object): Exchange {
  const { error } = delegateRequired.body as { error: object };
  return { ...delegateRequired, body: { error: { ...error, accepts: [delegateOffer, requirements] } } };
}

const request = {
  method: 'POST',
  headers: { authorization: 'Bearer lcai_test', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'llama3-8b', messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
};

/** The PaymentPayload a request carried in its PAYMENT-SIGNATURE header. */
const paymentOf = (sent: { headers: Headers }) =>
  JSON.parse(Buffer.from(sent.headers.get('payment-signature')!, 'base64').toString('utf8'));

/** Pins the clock and the random nonce to the ones the vector was signed with. */
function signAs(t: TestContext, v: Vector) {
  const { deadline, nonce } = v.paymentPayload.payload.authorization;
  t.mock.timers.enable({ apis: ['Date'], now: (Number(deadline) - v.paymentRequirements.maxTimeoutSeconds) * 1000 });
  t.mock.method(crypto, 'getRandomValues', (bytes: Uint8Array) => {
    bytes.set(hexToBytes(nonce as Hex));
    return bytes;
  });
}

const perCall = (fetch: typeof globalThis.fetch, transport = replayRpc([]).transport) => ({
  account: privateKeyToAccount(payerKey),
  apiKey: 'lcai_test',
  fetch,
  transport,
  payment: 'per-call' as const,
  maxPaymentWei: 10n ** 18n,
});
const networkOf = (v: Vector) => (v.chain.chainId === networks.mainnet.chainId ? 'mainnet' : 'testnet');

// The vectors whose payload is the one the SDK builds from their requirements:
// the payer's key, maxAmount = amount, deadline = now + maxTimeoutSeconds. The
// others carry a payload another signer got wrong (another payer, cap,
// facilitator or payTo; another chain's domain; version 1), or requirements
// the SDK refuses (below).
const signedBySdk = [
  'valid-testnet',
  'valid-mainnet',
  'valid-at-deadline',
  'valid-self-settled',
  'expired',
  'facilitator-not-authorized',
  'replayed',
  'expired-and-replayed',
  'insufficient-balance',
];
for (const name of signedBySdk) {
  test(`signs the ${name} vector byte for byte and sends it as PAYMENT-SIGNATURE`, async (t) => {
    const v = vector(name);
    signAs(t, v);
    const http = replayHttp([paymentRequired(v.paymentRequirements), completed]);
    const rpc = replayRpc([]);
    const lc = new Lightchain({ network: networkOf(v), ...perCall(http.fetch, rpc.transport) });

    const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

    assert.equal(response.status, 200);
    assert.deepEqual(paymentOf(http.sent[1]), v.paymentPayload);
    assert.equal(http.sent[1].headers.get('authorization'), 'Bearer lcai_test', 'the retry keeps the API key');
    assert.deepEqual(rpc.sent, [], 'x402 sends no transaction');
    http.done();
  });
}

const refusedVectors: [string, RegExp][] = [
  ['unsupported-network', /network eip155:1, not eip155:8200/],
  ['wrong-asset', /not this network's JobRegistry/],
  ['wrong-domain-version', /version 2/],
  ['unsupported-scheme', /no prepaid-debit payment/],
];
for (const [name, reason] of refusedVectors) {
  test(`does not sign the requirements of the ${name} vector, and says why`, async () => {
    const v = vector(name);
    const http = replayHttp([paymentRequired(v.paymentRequirements)]);
    const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch) });

    const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

    assert.equal(response.status, 402);
    const { error } = (await response.json()) as { error: { message: string } };
    assert.match(error.message, /^Not paid by the SDK: /);
    assert.match(error.message, reason);
    http.done();
  });
}

const testnetRequirements = vector('valid-testnet').paymentRequirements;
const fee = BigInt(testnetRequirements.amount);

/** The payment an x402-mode client with `maxPaymentWei` sends for requirements, or its 402 if it sends none. */
async function payWith(maxPaymentWei: bigint, requirements: object) {
  const http = replayHttp([paymentRequired(requirements), completed]);
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch), maxPaymentWei });
  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);
  if (response.status === 402) return { refused: ((await response.json()) as { error: { message: string } }).error.message };
  return { payment: paymentOf(http.sent[1]) };
}

test('pays a 402 asking for exactly maxPaymentWei, capping the authorization at the amount asked', async () => {
  const { payment } = await payWith(fee, testnetRequirements);
  assert.equal(payment.payload.authorization.maxAmount, testnetRequirements.amount);
});

test('caps the authorization at the amount asked, not at maxPaymentWei', async () => {
  const { payment } = await payWith(fee * 100n, testnetRequirements);
  assert.equal(payment.payload.authorization.maxAmount, testnetRequirements.amount);
});

test('does not pay a 402 asking for more than maxPaymentWei, and says why', async () => {
  const { refused } = await payWith(fee - 1n, testnetRequirements);
  assert.match(refused!, new RegExp(`^Not paid by the SDK: the 402 asks for ${fee} wei, more than maxPaymentWei \\(${fee - 1n}\\)`));
});

test('makes the authorization valid for maxTimeoutSeconds from now', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_500 });
  const { payment } = await payWith(fee, { ...testnetRequirements, maxTimeoutSeconds: 60 });
  assert.equal(payment.payload.authorization.deadline, '1800000060');
});

for (const timeout of [0, -1, 601, 1.5, '120', undefined]) {
  test(`does not pay a 402 whose maxTimeoutSeconds is ${JSON.stringify(timeout)}`, async () => {
    const { refused } = await payWith(fee, { ...testnetRequirements, maxTimeoutSeconds: timeout });
    assert.match(refused!, /maxTimeoutSeconds .* is not between 1 and 600/);
  });
}

for (const [what, requirements, reason] of [
  ['an amount that is not wei', { ...testnetRequirements, amount: '1e15' }, /amount 1e15 is not an amount in wei/],
  ['no facilitator', { ...testnetRequirements, extra: { ...testnetRequirements.extra, facilitatorAddress: 'nobody' } }, /facilitatorAddress/],
] as const) {
  test(`does not pay a 402 with ${what}`, async () => {
    const { refused } = await payWith(fee, requirements);
    assert.match(refused!, reason);
  });
}

test('draws a fresh nonce for every payment', async () => {
  const [a, b] = await Promise.all([payWith(fee, testnetRequirements), payWith(fee, testnetRequirements)]);
  assert.match(a.payment.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.payment.payload.authorization.nonce, b.payment.payload.authorization.nonce);
});

test('tells onPayment of the settlement the answer reports in PAYMENT-RESPONSE', async () => {
  const hash = completed.body && (completed.body as { lightchain: { tx_hash: Hex } }).lightchain.tx_hash;
  const settlement = { success: true, transaction: hash, network: 'eip155:8200', payer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', amount: '1000000000000000' };
  const settled = { ...completed, headers: { 'payment-response': Buffer.from(JSON.stringify(settlement)).toString('base64') } };
  const http = replayHttp([paymentRequired(testnetRequirements), settled]);
  const payments: unknown[] = [];
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch), onPayment: (p: Payment) => payments.push(p) });

  await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.deepEqual(payments, [{ hash, amount: 1_000_000_000_000_000n }]);
});

test('hands back a refused payment as the server answered it, telling onPayment nothing', async () => {
  const refusal = { ...paymentRequired(testnetRequirements), headers: { 'payment-response': Buffer.from(JSON.stringify({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:8200' })).toString('base64') } };
  const http = replayHttp([paymentRequired(testnetRequirements), refusal]);
  const payments: unknown[] = [];
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch), onPayment: (p: Payment) => payments.push(p) });

  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), refusal.body, 'sent once, not paid again');
  assert.deepEqual(payments, []);
  http.done();
});

test('in per-call mode, does not deposit on a 402 that only offers the delegate way, and says why', async () => {
  const http = replayHttp([delegateRequired]);
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch) });

  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.equal(response.status, 402);
  assert.match(((await response.json()) as { error: { message: string } }).error.message, /^Not paid by the SDK: payment is "per-call", and the 402 offers no prepaid-debit payment/);
  http.done();
});

test('asks for maxPaymentWei in per-call mode, with no default', () => {
  const options = { network: 'testnet', account: privateKeyToAccount(payerKey), apiKey: 'lcai_test', payment: 'per-call' } as const;
  assert.throws(() => new Lightchain(options as unknown as LightchainOptions), /maxPaymentWei/);
  assert.throws(() => new Lightchain({ ...options, maxPaymentWei: 0n }), /maxPaymentWei/);
});

test('refuses a payment mode it does not know, the former name "x402" included', () => {
  const options = { network: 'testnet', account: privateKeyToAccount(payerKey), apiKey: 'lcai_test', payment: 'x402' };
  assert.throws(() => new Lightchain(options as unknown as LightchainOptions), /"delegate" or "per-call"/);
});

test('refuses the options of one mode in the other, so a cap is never silently ignored', () => {
  const base = { network: 'testnet', account: privateKeyToAccount(payerKey), apiKey: 'lcai_test' } as const;
  assert.throws(() => new Lightchain({ ...base, maxPaymentWei: 1n } as unknown as LightchainOptions), /payment "per-call"/);
  assert.throws(() => new Lightchain({ ...base, onPayment: () => {} } as unknown as LightchainOptions), /payment "per-call"/);
  const perCallMode = { ...base, payment: 'per-call', maxPaymentWei: 1n } as const;
  assert.throws(() => new Lightchain({ ...perCallMode, depositWei: 1n } as unknown as LightchainOptions), /payment "delegate"/);
});

test('carries the payment on a Request sent again, keeping its own headers', async () => {
  const http = replayHttp([paymentRequired(testnetRequirements), completed]);
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch) });

  const response = await lc.fetch(new Request(`${lc.baseURL}/chat/completions`, request));

  assert.equal(response.status, 200);
  assert.equal(http.sent[1].headers.get('authorization'), 'Bearer lcai_test');
  assert.equal(paymentOf(http.sent[1]).accepted.asset, testnetRequirements.asset);
  assert.deepEqual(http.sent[1].body, http.sent[0].body);
});

/** The Developer API's 402 to a call with no API key: the x402 requirements alone. */
function keylessPaymentRequired(requirements: object): Exchange {
  const { error } = delegateRequired.body as { error: object };
  return { ...delegateRequired, body: { error: { ...error, code: 'payment_required', accepts: [requirements] } } };
}

for (const apiKey of [undefined, '']) {
  test(`with apiKey ${JSON.stringify(apiKey)}, calls keyless: no Authorization header, on the call or on its paid retry`, async () => {
    const http = replayHttp([keylessPaymentRequired(testnetRequirements), completed]);
    const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch), apiKey });

    // As the OpenAI SDK sends it: with some key in Authorization, which fetch drops.
    const response = await lc.fetch(`${lc.baseURL}/chat/completions`, request);

    assert.equal(response.status, 200);
    assert.equal(lc.apiKey, 'keyless', 'a placeholder for the OpenAI SDK, which insists on a key');
    assert.deepEqual(http.sent.map((s) => s.headers.get('authorization')), [null, null]);
    assert.equal(http.sent[0].headers.get('content-type'), 'application/json', 'the other headers go out as given');
    assert.equal(paymentOf(http.sent[1]).accepted.asset, testnetRequirements.asset);
    http.done();
  });
}

test('with no apiKey, sends no Authorization header from a Request either', async () => {
  const http = replayHttp([keylessPaymentRequired(testnetRequirements), completed]);
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch), apiKey: undefined });

  const response = await lc.fetch(new Request(`${lc.baseURL}/chat/completions`, request));

  assert.equal(response.status, 200);
  assert.deepEqual(http.sent.map((s) => s.headers.get('authorization')), [null, null]);
  assert.deepEqual(http.sent[1].body, http.sent[0].body);
});

test('with an apiKey, the key goes out on the call and on its paid retry', async () => {
  const http = replayHttp([paymentRequired(testnetRequirements), completed]);
  const lc = new Lightchain({ network: 'testnet', ...perCall(http.fetch) });

  await lc.fetch(`${lc.baseURL}/chat/completions`, request);

  assert.deepEqual(http.sent.map((s) => s.headers.get('authorization')), ['Bearer lcai_test', 'Bearer lcai_test']);
});

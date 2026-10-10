// End to end in x402 mode with no API key: a wallet that only deposits into
// its prepaid balance, and never authorizes a delegate or mints a key, gets a
// 402 listing x402 alone, then a completion through the OpenAI SDK paid by
// x402, then one refusal of two calls sent at once past the payer's
// concurrency limit.
//
//   WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_NETWORK=testnet LIGHTCHAIN_MODEL=gemma4:e2b npm run acceptance:x402
//
// Another network (a devnet): set LIGHTCHAIN_API_URL, LIGHTCHAIN_RPC_URL,
// LIGHTCHAIN_CHAIN_ID and LIGHTCHAIN_JOB_REGISTRY instead of LIGHTCHAIN_NETWORK.
// LIGHTCHAIN_MODEL is required: with no key there is no /v1/models to ask.
// Optional: LIGHTCHAIN_DEPOSIT_WEI (default 0.1 LCAI), LIGHTCHAIN_MAX_PAYMENT_WEI
// (default 0.05 LCAI), LIGHTCHAIN_PAYER_CONCURRENCY (the server's per-payer
// limit, default 1).
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { type Address, createPublicClient, type Hex, http, isAddressEqual } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, type LightchainJob, type Payment } from '../src/index.ts';

const env = process.env;
const network = env.LIGHTCHAIN_API_URL
  ? {
      chainId: Number(env.LIGHTCHAIN_CHAIN_ID),
      apiUrl: env.LIGHTCHAIN_API_URL,
      rpcUrl: env.LIGHTCHAIN_RPC_URL ?? '',
      jobRegistry: env.LIGHTCHAIN_JOB_REGISTRY as Address,
    }
  : ((env.LIGHTCHAIN_NETWORK ?? 'testnet') as 'mainnet' | 'testnet');
const model = env.LIGHTCHAIN_MODEL;
if (!model) throw new Error('Set LIGHTCHAIN_MODEL.');

const payments: Payment[] = [];
const lc = new Lightchain({
  network,
  account: privateKeyToAccount(env.WALLET_PRIVATE_KEY as Hex),
  payment: 'x402',
  maxPaymentWei: BigInt(env.LIGHTCHAIN_MAX_PAYMENT_WEI ?? 5n * 10n ** 16n),
  keyless: true,
  onPayment: (p) => {
    payments.push(p);
    console.log(`402 paid by x402: settlement tx ${p.hash}, ${p.amount} wei debited`);
  },
});
const chain = createPublicClient({ transport: http(lc.network.rpcUrl) });
// Keyless, lc.apiKey is a placeholder lc.fetch never sends.
const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: lc.apiKey, fetch: lc.fetch, maxRetries: 0 });
const ask = (content: string) => openai.chat.completions.create({ model, messages: [{ role: 'user', content }] });
console.log(`wallet ${lc.address}, chain ${lc.network.chainId}, API ${lc.baseURL}, model ${model}`);

const deposit = await lc.deposit(BigInt(env.LIGHTCHAIN_DEPOSIT_WEI ?? 10n ** 17n));
console.log(`deposit() tx ${deposit}; prepaid balance`, await lc.getBalance());

console.log('\n== no key, no payment ==');
const unpaid = await fetch(`${lc.baseURL}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
});
type Accept = { scheme: string; payTo: Address; extra: { facilitatorAddress: Address } };
const { error } = (await unpaid.json()) as { error: { code: string; accepts: Accept[] } };
console.log(`${unpaid.status} ${error.code}, accepts ${error.accepts?.map((a) => a.scheme).join(', ')}, PAYMENT-REQUIRED ${unpaid.headers.has('payment-required') ? 'set' : 'missing'}`);
assert.equal(unpaid.status, 402);
assert.deepEqual(error.accepts.map((a) => a.scheme), ['prepaid-debit'], 'x402 alone: no wallet to name a delegate for');
assert.ok(unpaid.headers.has('payment-required'));
const [{ payTo, extra }] = error.accepts;
const before = await lc.getBalance(payTo);
assert.equal(before.authorized, false, 'the wallet must have no delegate: run with a fresh one');

console.log('\n== keyless x402 through the OpenAI SDK ==');
const completion = await ask('Say hello in five words.');
const job = (completion as unknown as { lightchain: LightchainJob }).lightchain;
console.log(`answer: ${completion.choices[0]?.message.content}`);
console.log('job:', job);
const settlement = await chain.getTransactionReceipt({ hash: job.tx_hash });
console.log(`settlement ${job.tx_hash}: ${settlement.status}, from ${settlement.from} to ${settlement.to}`);
assert.deepEqual(payments.map((p) => p.hash), [job.tx_hash], 'onPayment reports the settlement lightchain.tx_hash names');
assert.equal(settlement.status, 'success');
assert.ok(isAddressEqual(settlement.from, extra.facilitatorAddress) && isAddressEqual(settlement.to!, lc.network.jobRegistry));
const after = await lc.getBalance(payTo);
console.log('prepaid balance after:', after);
assert.equal(after.authorized, false, 'x402 authorized no delegate');
assert.equal(before.balance - after.balance, payments[0].amount);

const limit = Number(env.LIGHTCHAIN_PAYER_CONCURRENCY ?? 1);
console.log(`\n== ${limit + 1} calls at once, past the payer's concurrency limit of ${limit} ==`);
const outcomes = await Promise.allSettled(Array.from({ length: limit + 1 }, (_, i) => ask(`Count to ${i + 2}.`)));
const refused = outcomes.flatMap((o) => (o.status === 'rejected' ? [o.reason] : []));
for (const o of outcomes) {
  if (o.status === 'fulfilled') console.log(`served, settlement ${(o.value as unknown as { lightchain: LightchainJob }).lightchain.tx_hash}`);
  else console.log(`refused: ${o.reason.status} ${o.reason.code}: ${o.reason.message}`);
}
assert.equal(refused.length, 1, 'one call refused');
assert.ok(refused[0] instanceof OpenAI.APIError && refused[0].status === 429 && refused[0].code === 'concurrency_limit_exceeded');
assert.equal(payments.length, 1 + limit, 'the refused call paid nothing');

console.log(`\nPASS: keyless x402 job ${job.job_id} (settlement ${job.tx_hash}); ${limit} of ${limit + 1} calls at once served, one refused`);

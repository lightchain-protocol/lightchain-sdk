// End to end in both payment modes with one funded key that has authorized no
// delegate: deposit into the prepaid balance alone, get a completion paid by
// x402 through the OpenAI SDK, then one on the delegate path with the same
// wallet and API key.
//
//   WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_NETWORK=testnet npm run acceptance:x402
//
// Another network (a devnet): set LIGHTCHAIN_API_URL, LIGHTCHAIN_RPC_URL,
// LIGHTCHAIN_CHAIN_ID and LIGHTCHAIN_JOB_REGISTRY instead of LIGHTCHAIN_NETWORK.
// Optional: LIGHTCHAIN_MODEL (default: the first listed), LIGHTCHAIN_DEPOSIT_WEI
// (default 0.1 LCAI), LIGHTCHAIN_MAX_PAYMENT_WEI (default 0.01 LCAI).
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
const account = privateKeyToAccount(env.WALLET_PRIVATE_KEY as Hex);

const x402 = new Lightchain({
  network,
  account,
  payment: 'x402',
  maxPaymentWei: BigInt(env.LIGHTCHAIN_MAX_PAYMENT_WEI ?? 10n ** 16n),
  onPayment: (p) => {
    payments.push(p);
    console.log(`402 paid by x402: settlement tx ${p.hash}, ${p.amount} wei debited`);
  },
});
const payments: Payment[] = [];
let delegate: Address | undefined;
const delegated = new Lightchain({
  network,
  account,
  onDeposit: (d) => {
    delegate = d.delegate;
    console.log(`402 paid by the delegate path: depositAndAuthorize(${d.delegate}) with ${d.value} wei, tx ${d.hash}`);
  },
});
const chain = createPublicClient({ transport: http(x402.network.rpcUrl) });
console.log(`wallet ${x402.address}, chain ${x402.network.chainId}, API ${x402.baseURL}`);

const deposit = await x402.deposit(BigInt(env.LIGHTCHAIN_DEPOSIT_WEI ?? 10n ** 17n));
console.log(`deposit() tx ${deposit}; prepaid balance`, await x402.getBalance());

const key = await x402.createApiKey({ name: 'sdk-acceptance-x402' });
console.log(`minted key ${key.prefix}... (id ${key.id})`);
const model =
  env.LIGHTCHAIN_MODEL ?? (await new OpenAI({ baseURL: x402.baseURL, apiKey: key.key }).models.list()).data[0]?.id;
if (!model) throw new Error('No model is served right now.');
console.log(`model ${model}`);

/** One completion through the OpenAI SDK with the client's fetch; its job on chain. */
async function complete(lc: Lightchain): Promise<LightchainJob> {
  const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: key.key, fetch: lc.fetch, maxRetries: 0 });
  const completion = await openai.chat.completions.create({
    model: model!,
    messages: [{ role: 'user', content: 'Say hello in five words.' }],
  });
  const job = (completion as unknown as { lightchain: LightchainJob }).lightchain;
  console.log(`answer: ${completion.choices[0]?.message.content}`);
  console.log('job:', job);
  return job;
}

// Unpaid, the call answers 402 with both ways to pay; the wallet has authorized no delegate.
const unpaid = await fetch(`${x402.baseURL}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
});
assert.equal(unpaid.status, 402, 'the wallet must have no delegate: run with a fresh key');
type Accept = { scheme: string; delegate?: Address; extra?: { facilitatorAddress: Address } };
const { error } = (await unpaid.json()) as { error: { code: string; accepts: Accept[] } };
const apiDelegate = error.accepts.find((a) => a.scheme === 'delegate')!.delegate!;
const facilitator = error.accepts.find((a) => a.scheme === 'prepaid-debit')?.extra?.facilitatorAddress;
console.log(`unpaid: ${unpaid.status} ${error.code}, accepts ${error.accepts.map((a) => a.scheme).join(', ')}`);
const before = await x402.getBalance(apiDelegate);
console.log(`the API's delegate ${apiDelegate}:`, before);
assert.equal(before.authorized, false);
assert.ok(facilitator, 'the API takes no x402 payments');

console.log('\n== x402 mode ==');
const paid = await complete(x402);
const settlement = await chain.getTransactionReceipt({ hash: paid.tx_hash });
console.log(`settlement ${paid.tx_hash}: ${settlement.status}, from ${settlement.from} to ${settlement.to}`);
assert.deepEqual(payments.map((p) => p.hash), [paid.tx_hash], 'onPayment reports the settlement lightchain.tx_hash names');
assert.equal(settlement.status, 'success');
assert.ok(isAddressEqual(settlement.from, facilitator) && isAddressEqual(settlement.to!, x402.network.jobRegistry));
const afterX402 = await x402.getBalance(apiDelegate);
console.log('prepaid balance after x402:', afterX402);
assert.equal(afterX402.authorized, false, 'x402 authorized no delegate');
assert.equal(before.balance - afterX402.balance, payments[0].amount);

console.log('\n== delegate mode, same wallet and key ==');
const viaDelegate = await complete(delegated);
assert.ok(delegate && isAddressEqual(delegate, apiDelegate), 'the delegate mode paid the 402 with depositAndAuthorize');
assert.equal(payments.length, 1, 'the delegate mode signed no x402 payment');
const after = await delegated.getBalance(delegate);
console.log('prepaid balance after the delegate path:', after);
assert.equal(after.authorized, true);
console.log(`\nPASS: x402 job ${paid.job_id} (settlement ${paid.tx_hash}), delegate job ${viaDelegate.job_id} (tx ${viaDelegate.tx_hash})`);

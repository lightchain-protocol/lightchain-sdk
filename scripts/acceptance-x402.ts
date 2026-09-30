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
import OpenAI from 'openai';
import { type Address, createPublicClient, type Hex, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, type LightchainJob } from '../src/index.ts';

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
  onPayment: (p) => console.log(`402 paid by x402: settlement tx ${p.hash}, ${p.amount} wei debited`),
});
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
const { error } = (await unpaid.json()) as { error: { code: string; accepts?: { scheme: string; delegate?: Address }[] } };
const apiDelegate = error.accepts?.find((a) => a.scheme === 'delegate')?.delegate;
console.log(`unpaid: ${unpaid.status} ${error.code}, accepts ${error.accepts?.map((a) => a.scheme).join(', ')}`);
if (apiDelegate) console.log(`the API's delegate ${apiDelegate}:`, await x402.getBalance(apiDelegate));

console.log('\n== x402 mode ==');
const paid = await complete(x402);
const settlement = await chain.getTransactionReceipt({ hash: paid.tx_hash });
console.log(`settlement ${paid.tx_hash}: ${settlement.status}, from ${settlement.from} to ${settlement.to}`);
console.log('prepaid balance after x402:', await x402.getBalance());

console.log('\n== delegate mode, same wallet and key ==');
await complete(delegated);
if (!delegate) throw new Error('The delegate mode paid no 402.');
console.log('prepaid balance after the delegate path:', await delegated.getBalance(delegate));

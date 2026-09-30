// End to end with a funded key: mint an API key, get a completion through the
// OpenAI SDK, paying the first 402 on the way.
//
//   WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_NETWORK=testnet npm run acceptance
//
// Another network (a devnet): set LIGHTCHAIN_API_URL, LIGHTCHAIN_RPC_URL,
// LIGHTCHAIN_CHAIN_ID and LIGHTCHAIN_JOB_REGISTRY instead of LIGHTCHAIN_NETWORK.
// Optional: LIGHTCHAIN_MODEL (default: the first listed), LIGHTCHAIN_DEPOSIT_WEI.
import OpenAI from 'openai';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, type LightchainJob } from '../src/index.ts';

const env = process.env;
const lc = new Lightchain({
  network: env.LIGHTCHAIN_API_URL
    ? {
        chainId: Number(env.LIGHTCHAIN_CHAIN_ID),
        apiUrl: env.LIGHTCHAIN_API_URL,
        rpcUrl: env.LIGHTCHAIN_RPC_URL ?? '',
        jobRegistry: env.LIGHTCHAIN_JOB_REGISTRY as Address,
      }
    : ((env.LIGHTCHAIN_NETWORK ?? 'testnet') as 'mainnet' | 'testnet'),
  account: privateKeyToAccount(env.WALLET_PRIVATE_KEY as Hex),
  depositWei: env.LIGHTCHAIN_DEPOSIT_WEI ? BigInt(env.LIGHTCHAIN_DEPOSIT_WEI) : undefined,
  onDeposit: (d) => {
    delegate = d.delegate;
    console.log(`402 paid: depositAndAuthorize(${d.delegate}) with ${d.value} wei, tx ${d.hash}`);
  },
});
let delegate: Address | undefined;
console.log(`wallet ${lc.address}, chain ${lc.network.chainId}, API ${lc.baseURL}`);

const key = await lc.createApiKey({ name: 'sdk-acceptance' });
console.log(`minted key ${key.prefix}... (id ${key.id}, scope ${key.scope})`);
console.log('prepaid balance before:', await lc.getBalance());

const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: key.key, fetch: lc.fetch });
const model = env.LIGHTCHAIN_MODEL ?? (await openai.models.list()).data[0]?.id;
if (!model) throw new Error('No model is served right now.');
console.log(`model ${model}`);

const completion = await openai.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Say hello in five words.' }],
});
console.log(`answer: ${completion.choices[0]?.message.content}`);
console.log('job:', (completion as unknown as { lightchain: LightchainJob }).lightchain);
console.log('prepaid balance after:', await lc.getBalance(delegate));

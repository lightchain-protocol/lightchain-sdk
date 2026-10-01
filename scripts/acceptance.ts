// End to end with an API key, on a fresh wallet: a client holding only the
// key gets the 402 of the unpaid wallet back as it is; the same key with the
// wallet as `account` pays that 402 with one depositAndAuthorize and gets a
// completion through the OpenAI SDK.
//
//   WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_NETWORK=testnet npm run acceptance
//
// The key: LIGHTCHAIN_API_KEY, one the wallet created in the chat (Developer,
// API keys); without it, the script mints one for the wallet the way that page
// does, through the API's /api/auth and /api/api-keys routes.
// Another network (a devnet): set LIGHTCHAIN_API_URL, LIGHTCHAIN_RPC_URL,
// LIGHTCHAIN_CHAIN_ID and LIGHTCHAIN_JOB_REGISTRY instead of LIGHTCHAIN_NETWORK.
// Optional: LIGHTCHAIN_MODEL (default: the first listed), LIGHTCHAIN_DEPOSIT_WEI.
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { type Address, type Hex, isAddressEqual, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { type Deposit, Lightchain, type LightchainJob, networks } from '../src/index.ts';

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

/** Signs in with Sign-In with Ethereum and mints an API key for the wallet, as the chat's API keys page does. */
async function mintApiKey(apiUrl: string, wallet: LocalAccount, name: string): Promise<string> {
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${apiUrl}${path}`, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
    return body as T;
  };
  const json = { 'content-type': 'application/json' };
  const { message } = await api<{ message: string }>(`/api/auth/challenge?address=${wallet.address}`);
  // The server writes the message: sign only a sign-in for this wallet.
  const { address } = parseSiweMessage(message);
  assert.ok(address && isAddressEqual(address, wallet.address), `the sign-in message is for ${address}, not ${wallet.address}`);
  const signature = await wallet.signMessage({ message });
  const { token } = await api<{ token: string }>('/api/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ message, signature }) });
  const created = await api<{ key: string; prefix: string; id: string }>('/api/api-keys', {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  console.log(`minted key ${created.prefix}... (id ${created.id}) by Sign-In with Ethereum`);
  return created.key;
}

const { apiUrl } = typeof network === 'string' ? networks[network] : network;
const apiKey = env.LIGHTCHAIN_API_KEY ?? (await mintApiKey(apiUrl, account, 'sdk-acceptance'));
const deposits: Deposit[] = [];
const lc = new Lightchain({
  network,
  apiKey,
  account,
  depositWei: env.LIGHTCHAIN_DEPOSIT_WEI ? BigInt(env.LIGHTCHAIN_DEPOSIT_WEI) : undefined,
  onDeposit: (d) => {
    deposits.push(d);
    console.log(`402 paid: depositAndAuthorize(${d.delegate}) with ${d.value} wei, tx ${d.hash}`);
  },
});
console.log(`wallet ${account.address}, chain ${lc.network.chainId}, API ${lc.baseURL}`);

console.log('\n== the key alone: the 402 comes back ==');
const keyOnly = new Lightchain({ network, apiKey });
const plain = new OpenAI({ baseURL: keyOnly.baseURL, apiKey: keyOnly.apiKey, fetch: keyOnly.fetch, maxRetries: 0 });
const model = env.LIGHTCHAIN_MODEL ?? (await plain.models.list()).data[0]?.id;
if (!model) throw new Error('No model is served right now.');
console.log(`model ${model}`);
const before = await lc.getBalance();
const ask = (openai: OpenAI) => openai.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say hello in five words.' }] });
const refused = await ask(plain).then(
  () => assert.fail('the key alone was served: run with a fresh wallet, one with no delegate'),
  (e: unknown) => e,
);
assert.ok(refused instanceof OpenAI.APIError, String(refused));
const accepts = (refused.error as { accepts?: { scheme: string; delegate: Address }[] } | undefined)?.accepts ?? [];
console.log(`${refused.status} ${refused.code}: ${refused.message}; accepts ${accepts.map((a) => a.scheme).join(', ')}`);
assert.equal(refused.status, 402);
assert.ok(['delegate_not_authorized', 'insufficient_balance', 'allowance_exhausted'].includes(String(refused.code)));
assert.doesNotMatch(refused.message, /Not paid by the SDK/, 'handed back as the API answered it');
assert.deepEqual(await lc.getBalance(), before, 'the key alone sent nothing');

console.log('\n== the key and the wallet as account: the SDK pays the 402 ==');
console.log('prepaid balance before:', before);
const completion = await ask(new OpenAI({ baseURL: lc.baseURL, apiKey: lc.apiKey, fetch: lc.fetch, maxRetries: 0 }));
const job = (completion as unknown as { lightchain: LightchainJob }).lightchain;
console.log(`answer: ${completion.choices[0]?.message.content}`);
console.log('job:', job);
assert.equal(deposits.length, 1, 'one depositAndAuthorize');
const after = await lc.getBalance(deposits[0].delegate);
console.log('prepaid balance after:', after);
assert.equal(after.authorized, true);

console.log(`\nPASS: the key alone got its ${refused.code} 402 back; with the account, deposit ${deposits[0].hash} paid it and job ${job.job_id} ran`);

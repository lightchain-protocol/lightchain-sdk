// The session pool on a live network: a streaming completion, then two conversations on one key with
// interleaved turns. Each conversation must keep its own history, and a free pooled session is reused
// instead of opening a new one. Prints every job so its transaction can be checked on chain.
//
//   WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_NETWORK=testnet npm run acceptance:pool
//
// The wallet needs LCAI for one deposit (LIGHTCHAIN_DEPOSIT_WEI, default 0.2 LCAI) and its gas; the script
// mints its own API key by Sign-In with Ethereum. Optional: LIGHTCHAIN_MODEL (default gemma4:e2b).
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, type LightchainJob, networks } from '../src/index.ts';

const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as Hex);
const network = (process.env.LIGHTCHAIN_NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
const { apiUrl } = networks[network];

async function mintApiKey(): Promise<string> {
  const post = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
    const r = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  const { message } = (await (await fetch(`${apiUrl}/api/auth/challenge?address=${account.address}`)).json()) as { message: string };
  const { token } = await post<{ token: string }>('/api/auth/verify', { message, signature: await account.signMessage({ message }) });
  const { key, prefix } = await post<{ key: string; prefix: string }>('/api/api-keys', { name: 'sdk-acceptance-pool' }, token);
  console.log(`minted key ${prefix}...`);
  return key;
}

const lc = new Lightchain({
  network,
  apiKey: await mintApiKey(),
  account,
  depositWei: BigInt(process.env.LIGHTCHAIN_DEPOSIT_WEI ?? 200_000_000_000_000_000n),
});
const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: lc.apiKey, fetch: lc.fetch, maxRetries: 0 });
const model = process.env.LIGHTCHAIN_MODEL ?? 'gemma4:e2b';
const jobs: { label: string; job: LightchainJob; ms: number }[] = [];

console.log('\n== streaming ==');
let t = Date.now();
const stream = await openai.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: 'Count from one to five in words.' }] });
let text = '';
let chunks = 0;
let streamJob: LightchainJob | undefined;
for await (const chunk of stream) {
  chunks++;
  text += chunk.choices[0]?.delta?.content ?? '';
  streamJob ??= (chunk as unknown as { lightchain?: LightchainJob }).lightchain;
}
assert.ok(streamJob, 'the last chunk names the job');
assert.ok(text.length > 0, 'streamed text');
jobs.push({ label: 'stream', job: streamJob, ms: Date.now() - t });
console.log(`${chunks} chunks: ${JSON.stringify(text)}`);

console.log('\n== two conversations, interleaved ==');
type Msg = { role: 'user' | 'assistant'; content: string };
const turn = async (label: string, history: Msg[], content: string): Promise<string> => {
  history.push({ role: 'user', content });
  t = Date.now();
  const c = await openai.chat.completions.create({ model, messages: history });
  const answer = c.choices[0]?.message.content ?? '';
  history.push({ role: 'assistant', content: answer });
  jobs.push({ label, job: (c as unknown as { lightchain: LightchainJob }).lightchain, ms: Date.now() - t });
  console.log(`${label}: ${JSON.stringify(answer)}`);
  return answer;
};
const a: Msg[] = [];
const b: Msg[] = [];
await turn('A1', a, 'My name is Alice and my favourite colour is green. Reply with just OK.');
await turn('B1', b, 'My name is Bob and my favourite colour is purple. Reply with just OK.');
const a2 = await turn('A2', a, 'What is my name and my favourite colour? Answer in one short sentence.');
const b2 = await turn('B2', b, 'What is my name and my favourite colour? Answer in one short sentence.');
assert.match(a2, /alice/i, 'A remembers Alice');
assert.doesNotMatch(a2, /bob|purple/i, 'A does not see B');
assert.match(b2, /bob/i, 'B remembers Bob');
assert.doesNotMatch(b2, /alice|green/i, 'B does not see A');

console.log('\n== jobs ==');
for (const { label, job, ms } of jobs) console.log(`${label}\tjob ${job.job_id}\tsession ${job.session_id}\tworker ${job.worker}\t${ms} ms\ttx ${job.tx_hash}`);
const sessions = new Set(jobs.map((j) => j.job.session_id));
console.log(`\nsessions used: ${[...sessions].join(', ')} (${sessions.size} for ${jobs.length} jobs)`);
assert.equal(sessions.size, 1, 'one pooled session serves every sequential call on the key');
console.log('PASS: streaming completion named its job; interleaved conversations kept their own history');

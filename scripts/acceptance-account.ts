// End to end for agents: a fresh key holding LCAI becomes a smart account
// through the Developer API's sponsor, installs an agent key, and the agent
// key gets a completion through the OpenAI SDK, paying its 402 from the smart
// account with a batch it signs. Then the owner revokes the key.
//
//   WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_NETWORK=testnet npm run acceptance:account
//
// WALLET_PRIVATE_KEY must be a fresh key (no code, never set up) holding some
// LCAI. Another network (a devnet): set LIGHTCHAIN_API_URL, LIGHTCHAIN_RPC_URL,
// LIGHTCHAIN_CHAIN_ID, LIGHTCHAIN_JOB_REGISTRY and LIGHTCHAIN_ACCOUNT_IMPLEMENTATION
// instead of LIGHTCHAIN_NETWORK. Optional: LIGHTCHAIN_MODEL (default: the first listed).
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { type Address, createPublicClient, type Hex, http, isAddressEqual, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { type Deposit, Lightchain, type LightchainJob, lightChainAccountAbi, networks } from '../src/index.ts';

const env = process.env;
const network = env.LIGHTCHAIN_API_URL
  ? {
      chainId: Number(env.LIGHTCHAIN_CHAIN_ID),
      apiUrl: env.LIGHTCHAIN_API_URL,
      rpcUrl: env.LIGHTCHAIN_RPC_URL ?? '',
      jobRegistry: env.LIGHTCHAIN_JOB_REGISTRY as Address,
      accountImplementation: env.LIGHTCHAIN_ACCOUNT_IMPLEMENTATION as Address,
    }
  : networks[(env.LIGHTCHAIN_NETWORK ?? 'testnet') as 'mainnet' | 'testnet'];
const lc = new Lightchain({ network, account: privateKeyToAccount(env.WALLET_PRIVATE_KEY as Hex) });
const chain = createPublicClient({ transport: http(lc.network.rpcUrl) });
console.log(`owner ${lc.address}, chain ${lc.network.chainId}, API ${lc.baseURL}`);
assert.equal(await chain.getCode({ address: lc.address }), undefined, 'WALLET_PRIVATE_KEY must be a fresh key');

console.log('\n== setup through the sponsor ==');
const key = await lc.createApiKey({ name: 'sdk-acceptance-account' });
console.log(`minted key ${key.prefix}... (id ${key.id})`);
// A token deposit: it authorizes the API's delegate, and the first completion's 402 is the agent key's to pay.
const setupDeposit = 1n;
const before = await chain.getBalance({ address: lc.address });
const setup = await lc.setupAccount({ apiKey: key.key, depositWei: setupDeposit });
const receipt = await chain.getTransactionReceipt({ hash: setup });
const code = await chain.getCode({ address: lc.address });
const after = await chain.getBalance({ address: lc.address });
console.log(`setup tx ${setup}: ${receipt.status}, type ${receipt.type}, sent by ${receipt.from}; code ${code}`);
console.log(`account LCAI ${before} -> ${after} wei`);
assert.ok(!isAddressEqual(receipt.from, lc.address) && isAddressEqual(receipt.to!, lc.address), 'the sponsor sent it to the account');
assert.equal(before - after, setupDeposit, 'the account paid the deposit and no gas');
console.log('prepaid balance:', await lc.getBalance());

console.log('\n== agent key ==');
const agentKey = privateKeyToAccount(generatePrivateKey());
const limits = { targets: [lc.network.jobRegistry], spendCapWei: parseEther('0.1'), expiry: new Date(Date.now() + 3_600_000) };
const install = await lc.installAgentKey(agentKey.address, { ...limits, gasWei: parseEther('0.01') });
const installed = await chain.readContract({ address: lc.address, abi: lightChainAccountAbi, functionName: 'agentKey', args: [agentKey.address] });
console.log(`installed ${agentKey.address} in ${install}:`, installed);
assert.deepEqual(installed.targets, limits.targets);
assert.equal(installed.remaining, limits.spendCapWei);

console.log('\n== completion with the agent key ==');
const deposits: Deposit[] = [];
const agent = new Lightchain({
  network,
  account: agentKey,
  agentOf: lc.address,
  onDeposit: (d) => {
    deposits.push(d);
    console.log(`402 paid by the agent key: depositAndAuthorize(${d.delegate}) with ${d.value} wei, batch tx ${d.hash}`);
  },
});
const openai = new OpenAI({ baseURL: agent.baseURL, apiKey: key.key, fetch: agent.fetch, maxRetries: 0 });
const model = env.LIGHTCHAIN_MODEL ?? (await openai.models.list()).data[0]?.id;
if (!model) throw new Error('No model is served right now.');
console.log(`model ${model}`);
const completion = await openai.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say hello in five words.' }] });
const job = (completion as unknown as { lightchain: LightchainJob }).lightchain;
console.log(`answer: ${completion.choices[0]?.message.content}`);
console.log('job:', job);
assert.equal(deposits.length, 1, 'the agent key paid the 402');
const batch = await chain.getTransactionReceipt({ hash: deposits[0].hash });
console.log(`batch ${deposits[0].hash}: ${batch.status}, from ${batch.from} to ${batch.to}`);
assert.ok(isAddressEqual(batch.from, agentKey.address) && isAddressEqual(batch.to!, lc.address), 'the agent key submitted its batch to the account');
const left = await chain.readContract({ address: lc.address, abi: lightChainAccountAbi, functionName: 'agentKey', args: [agentKey.address] });
assert.equal(left.remaining, limits.spendCapWei - deposits[0].value, 'the spend cap counts the deposit');
console.log('prepaid balance after:', await agent.getBalance(deposits[0].delegate));

console.log('\n== revoke ==');
console.log(`revoked in ${await lc.revokeAgentKey(agentKey.address)}`);
const refused = await agent.deposit(1n).then(
  () => null,
  (e: Error) => e.message,
);
console.log(`a batch of the revoked key: ${refused?.split('\n')[0]}`);
assert.match(refused ?? '', /AgentKeyNotInstalled/);
console.log(`\nPASS: smart account ${lc.address} (setup ${setup}), agent key ${agentKey.address} paid job ${job.job_id} (batch ${deposits[0].hash})`);

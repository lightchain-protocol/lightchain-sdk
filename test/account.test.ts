import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Address,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverAuthorizationAddress } from 'viem/utils';
import { Lightchain, LightchainError, lightChainAccountAbi } from '../src/index.ts';
import devnet from './fixtures/devnet.json' with { type: 'json' };
import mint from './fixtures/mint-key.json' with { type: 'json' };
import pay from './fixtures/pay-402.json' with { type: 'json' };
import { type Exchange, type RpcCall, replayHttp, replayRpc } from './replay.ts';

// The owner: Foundry's public test account 7, as in the recorded fixtures.
const owner = privateKeyToAccount(devnet.privateKey as Hex);
const IMPLEMENTATION: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const network = { ...(devnet.network as Lightchain['network']), accountImplementation: IMPLEMENTATION };
const DELEGATE: Address = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
// depositAndAuthorize(DELEGATE), as recorded in pay-402.json.
const DEPOSIT_AND_AUTHORIZE = '0x882fe3c90000000000000000000000009965507d1a55bcc2695c58ba16fb37d819b0a4dc';
const SETUP_TX: Hex = `0x${'5e'.repeat(32)}`;
const TX: Hex = `0x${'7a'.repeat(32)}`;
const agent = privateKeyToAccount(generatePrivateKey());
const DESIGNATOR = `0xef0100${IMPLEMENTATION.slice(2).toLowerCase()}`;

// The account's batch, as LightChainAccount hashes it.
const EXECUTIONS = {
  type: 'tuple[]',
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ],
} as const;
const BATCH_TYPES = {
  Batch: [
    { name: 'calls', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

type Execution = { target: Address; value: bigint; callData: Hex };
/** Who signed a batch of the owner's account. */
const batchSigner = (calls: readonly Execution[], nonce: bigint, deadline: bigint, signature: Hex) =>
  recoverTypedDataAddress({
    domain: { name: 'LightChainAccount', version: '1', chainId: 48221, verifyingContract: owner.address },
    types: BATCH_TYPES,
    primaryType: 'Batch',
    message: { calls: encodeAbiParameters([EXECUTIONS], [calls]), nonce, deadline },
    signature,
  });

const [challenge, signedIn] = mint as Exchange[];
const minedReceipt = pay.rpc.at(-1)!.result as Record<string, unknown>;
const balance: Exchange = { method: 'GET', path: '/api/balance', status: 200, body: { balance: '0', delegate: DELEGATE, delegateAuthorized: false } };
const setupAnswer = (status: number, body: object): Exchange => ({ method: 'POST', path: '/v1/account/setup', status, body });
const confirmed = setupAnswer(200, { account: owner.address, tx_hash: SETUP_TX, status: 'confirmed' });

/** The chain around a setup: the account's next nonce, then the setup mined and its code. */
function setupChain({ status = '0x1', code = DESIGNATOR } = {}): RpcCall[] {
  return [
    { method: 'eth_getTransactionCount', result: '0x3' },
    { method: 'eth_blockNumber', result: '0xe0' },
    { method: 'eth_getTransactionReceipt', result: { ...minedReceipt, transactionHash: SETUP_TX, to: owner.address.toLowerCase(), type: '0x4', logs: [], status } },
    { method: 'eth_getCode', result: code },
  ];
}

/** The chain around transactions the SDK sends: filled, broadcast and mined. */
function sendChain(extra: RpcCall[] = []): RpcCall[] {
  return [
    { method: 'eth_fillTransaction', result: pay.rpc[0].result },
    { method: 'eth_sendRawTransaction', result: TX },
    { method: 'eth_blockNumber', result: '0xe0' },
    { method: 'eth_getTransactionReceipt', result: { ...minedReceipt, transactionHash: TX, logs: [] } },
    ...extra,
  ];
}

/** The transactions the SDK sent: who signed each, where to, and the account batch it executes. */
async function sentBatches(sent: { method: string; params: unknown }[]) {
  const raws = sent.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => (c.params as [Hex])[0]);
  return Promise.all(
    raws.map(async (raw) => {
      const tx = parseTransaction(raw);
      assert.equal(tx.data?.slice(0, 10), '0xe9ae5c53', 'execute(bytes32,bytes)');
      const { args } = decodeFunctionData({ abi: lightChainAccountAbi, data: tx.data! });
      const [mode, executionData] = args as [Hex, Hex];
      return { from: await recoverTransactionAddress({ serializedTransaction: raw as never }), to: tx.to, value: tx.value ?? 0n, mode, executionData };
    }),
  );
}

test('sets up a smart account: signs the 7702 authorization and the deposit-and-authorize batch, and the sponsor sends them', async () => {
  const http = replayHttp([challenge, signedIn, balance, confirmed]);
  const rpc = replayRpc(setupChain());
  const lc = new Lightchain({ network, account: owner, fetch: http.fetch, transport: rpc.transport });

  const hash = await lc.setupAccount({ apiKey: devnet.apiKey, depositWei: 5000n });

  assert.equal(hash, SETUP_TX);
  const [, , readDelegate, setup] = http.sent;
  assert.equal(readDelegate.headers.get('authorization'), `Bearer ${(signedIn.body as { token: string }).token}`);
  assert.equal(setup.headers.get('authorization'), `Bearer ${devnet.apiKey}`);
  const body = setup.body as {
    authorization: { address: Address; chainId: number; nonce: number; r: Hex; s: Hex; yParity: number };
    calls: { to: Address; value: string; data: Hex }[];
    nonce: string;
    deadline: string;
    signature: Hex;
  };

  // The authorization: the network's account code, this chain, the account's next nonce, signed by the key.
  assert.deepEqual(
    { address: body.authorization.address, chainId: body.authorization.chainId, nonce: body.authorization.nonce },
    { address: IMPLEMENTATION, chainId: 48221, nonce: 3 },
  );
  assert.equal(await recoverAuthorizationAddress({ authorization: body.authorization }), owner.address);

  // The batch: one depositAndAuthorize of the API's delegate, the deposit from the account's own LCAI.
  assert.deepEqual(body.calls, [{ to: network.jobRegistry, value: '5000', data: DEPOSIT_AND_AUTHORIZE }]);
  assert.equal(body.nonce, '0');
  const deadline = Number(body.deadline) - Date.now() / 1000;
  assert.ok(deadline > 60 && deadline <= 600, `deadline ${deadline} s away`);
  const calls = body.calls.map((c) => ({ target: c.to, value: BigInt(c.value), callData: c.data }));
  assert.equal(await batchSigner(calls, 0n, BigInt(body.deadline), body.signature), owner.address);
  http.done();
});

test("raises the sponsor's refusal as a LightchainError with its status, code and details, waiting on nothing", async () => {
  // As consumer-api answers a second setup of the same account.
  const refusal = {
    error: {
      message: `The sponsor has already taken ${owner.address}'s setup; it pays for one per account.`,
      type: 'invalid_request_error',
      param: null,
      code: 'already_sponsored',
      tx_hash: SETUP_TX,
    },
  };
  const http = replayHttp([challenge, signedIn, balance, setupAnswer(409, refusal)]);
  const rpc = replayRpc(setupChain());
  const lc = new Lightchain({ network, account: owner, fetch: http.fetch, transport: rpc.transport });

  const error = await lc.setupAccount({ apiKey: devnet.apiKey, depositWei: 5000n }).catch((e: unknown) => e);

  assert.ok(error instanceof LightchainError);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'already_sponsored');
  assert.equal(error.message, refusal.error.message);
  assert.deepEqual(error.body, refusal);
  assert.deepEqual(rpc.sent.map((c) => c.method), ['eth_getTransactionCount'], 'no receipt waited for');
});

test('waits for a setup the sponsor answered as pending, and throws when it did not make a smart account', async () => {
  const pending = setupAnswer(202, { account: owner.address, tx_hash: SETUP_TX, status: 'pending' });
  for (const [outcome, chain] of [
    ['reverted', setupChain({ status: '0x0' })],
    ['ran without its authorization', setupChain({ code: '0x' })],
  ] as const) {
    const http = replayHttp([challenge, signedIn, balance, pending]);
    const rpc = replayRpc(chain);
    const lc = new Lightchain({ network, account: owner, fetch: http.fetch, transport: rpc.transport });

    await assert.rejects(lc.setupAccount({ apiKey: devnet.apiKey, depositWei: 5000n }), /did not make .* a smart account/, outcome);
    assert.ok(rpc.sent.some((c) => c.method === 'eth_getTransactionReceipt'), `${outcome}: waited for the receipt`);
  }
});

test('waits for a setup the sponsor sent without the node confirming it took it: it is spent either way', async () => {
  // As consumer-api answers a broadcast that went unanswered.
  const unconfirmed = setupAnswer(502, {
    error: { message: `The setup was sent as ${SETUP_TX}, and the node did not confirm it took it.`, type: 'server_error', param: null, code: 'send_unconfirmed', tx_hash: SETUP_TX },
  });
  const http = replayHttp([challenge, signedIn, balance, unconfirmed]);
  const rpc = replayRpc(setupChain());
  const lc = new Lightchain({ network, account: owner, fetch: http.fetch, transport: rpc.transport });

  assert.equal(await lc.setupAccount({ apiKey: devnet.apiKey, depositWei: 5000n }), SETUP_TX);
  assert.ok(rpc.sent.some((c) => c.method === 'eth_getTransactionReceipt'));
});

test('refuses to set up on a network that names no account code, before signing anything', async () => {
  const http = replayHttp([]);
  const lc = new Lightchain({ network: devnet.network as Lightchain['network'], account: owner, fetch: http.fetch });

  await assert.rejects(lc.setupAccount({ apiKey: devnet.apiKey, depositWei: 5000n }), /accountImplementation/);
  assert.equal(http.sent.length, 0);
});

test("installs an agent key with the owner's own transaction: its targets, spend cap and expiry, and LCAI for its gas", async () => {
  const rpc = replayRpc(sendChain());
  const lc = new Lightchain({ network, account: owner, transport: rpc.transport });

  const hash = await lc.installAgentKey(agent.address, {
    targets: [network.jobRegistry],
    spendCapWei: 10n ** 17n,
    expiry: new Date('2030-01-01T00:00:00Z'),
    gasWei: 10n ** 16n,
  });

  assert.equal(hash, TX);
  const [batch] = await sentBatches(rpc.sent);
  // From the account to itself, in the batch mode only the account itself may execute.
  assert.deepEqual(
    { from: batch.from, to: batch.to, value: batch.value, mode: batch.mode },
    { from: owner.address, to: owner.address.toLowerCase(), value: 0n, mode: '0x0100000000000000000000000000000000000000000000000000000000000000' },
  );
  const [[install, gas]] = decodeAbiParameters([EXECUTIONS], batch.executionData);
  assert.deepEqual({ target: install.target, value: install.value }, { target: owner.address, value: 0n });
  assert.equal(install.callData.slice(0, 10), '0x903b5ebc', 'installAgentKey(address,address[],uint256,uint64)');
  assert.deepEqual(decodeFunctionData({ abi: lightChainAccountAbi, data: install.callData }).args, [
    agent.address,
    [network.jobRegistry],
    10n ** 17n,
    1893456000n, // 2030-01-01T00:00:00Z
  ]);
  assert.deepEqual(gas, { target: agent.address, value: 10n ** 16n, callData: '0x' });
});

test("revokes an agent key with the owner's own transaction", async () => {
  const rpc = replayRpc(sendChain());
  const lc = new Lightchain({ network, account: owner, transport: rpc.transport });

  await lc.revokeAgentKey(agent.address);

  const [batch] = await sentBatches(rpc.sent);
  assert.deepEqual({ from: batch.from, to: batch.to }, { from: owner.address, to: owner.address.toLowerCase() });
  const [[revoke, ...rest]] = decodeAbiParameters([EXECUTIONS], batch.executionData);
  assert.deepEqual(rest, []);
  assert.deepEqual(
    { target: revoke.target, value: revoke.value, callData: revoke.callData },
    { target: owner.address, value: 0n, callData: `0xafdd971e${agent.address.slice(2).toLowerCase().padStart(64, '0')}` },
  );
});

test('a client with an agent key pays a 402 for its smart account with a batch the key signs and submits', async () => {
  const http = replayHttp(pay.http as Exchange[]);
  // The key's next batch nonce is 5.
  const rpc = replayRpc(sendChain([{ method: 'eth_call', result: `0x${'5'.padStart(64, '0')}` }]));
  const deposits: unknown[] = [];
  const lc = new Lightchain({ network, account: agent, agentOf: owner.address, fetch: http.fetch, transport: rpc.transport, onDeposit: (d) => deposits.push(d) });
  const minimum = 10n ** 15n; // the recorded 402's minimum_value_wei

  const response = await lc.fetch(`${lc.baseURL}/chat/completions`, { method: 'POST', body: '{}' });

  assert.equal(response.status, 200);
  assert.equal(lc.address, owner.address, 'the payer is the smart account');
  assert.deepEqual(deposits, [{ hash: TX, value: minimum, delegate: DELEGATE }]);
  const read = rpc.sent.find((c) => c.method === 'eth_call')!.params as [{ to: Address; data: Hex }];
  assert.deepEqual([read[0].to, read[0].data], [owner.address, `0x6eacfe50${agent.address.slice(2).toLowerCase().padStart(64, '0')}`], 'batchNonce(agent)');

  // Sent by the agent key to the account, in the signed-batch mode.
  const [batch] = await sentBatches(rpc.sent);
  assert.deepEqual(
    { from: batch.from, to: batch.to, value: batch.value, mode: batch.mode },
    { from: agent.address, to: owner.address.toLowerCase(), value: 0n, mode: '0x0100000000007821000100000000000000000000000000000000000000000000' },
  );
  const [calls, opData] = decodeAbiParameters([EXECUTIONS, { type: 'bytes' }], batch.executionData);
  assert.deepEqual(calls, [{ target: network.jobRegistry, value: minimum, callData: DEPOSIT_AND_AUTHORIZE }]);
  const [nonce, deadline, signature] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], opData);
  assert.equal(nonce, 5n);
  assert.equal(await batchSigner(calls, nonce, deadline, signature), agent.address);
  http.done();
});

test('a client with an agent key refuses what only the owner key can sign: a sign-in, an x402 payment', async () => {
  const http = replayHttp([]);
  const lc = new Lightchain({ network, account: agent, agentOf: owner.address, fetch: http.fetch });

  await assert.rejects(lc.createApiKey(), /agent key cannot sign in/);
  assert.equal(http.sent.length, 0);
  assert.throws(
    () => new Lightchain({ network, account: agent, agentOf: owner.address, payment: 'x402', maxPaymentWei: 1n }),
    /agent key cannot sign x402/,
  );
});

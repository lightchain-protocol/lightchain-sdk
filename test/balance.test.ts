import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain } from '../src/index.ts';
import balance from './fixtures/balance.json' with { type: 'json' };
import devnet from './fixtures/devnet.json' with { type: 'json' };
import { replayRpc } from './replay.ts';

const account = privateKeyToAccount(devnet.privateKey as Hex);
const network = devnet.network as Lightchain['network'];
// Recorded after a 0.5 LCAI deposit() and a 2 LCAI depositAndAuthorize; cast call read the same.

test("reads the wallet's prepaid balance from the JobRegistry", async () => {
  const rpc = replayRpc(balance.rpc);
  const lc = new Lightchain({ network, account, transport: rpc.transport });

  assert.deepEqual(await lc.getBalance(), { balance: 2_500_000_000_000_000_000n });
  assert.deepEqual(rpc.sent.map((c) => (c.params as [{ to: string }])[0].to), [network.jobRegistry]);
});

test("reads the delegate's authorization and allowance along with the balance", async () => {
  const rpc = replayRpc(balance.rpc);
  const lc = new Lightchain({ network, account, transport: rpc.transport });

  assert.deepEqual(await lc.getBalance(balance.delegate as Hex), {
    balance: 2_500_000_000_000_000_000n,
    authorized: true,
    allowance: 2_000_000_000_000_000_000n,
  });
});

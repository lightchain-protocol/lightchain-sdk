import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverMessageAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Lightchain, LightchainError } from '../src/index.ts';
import devnet from './fixtures/devnet.json' with { type: 'json' };
import keyLimit from './fixtures/key-limit-409.json' with { type: 'json' };
import mint from './fixtures/mint-key.json' with { type: 'json' };
import { replayHttp } from './replay.ts';

const account = privateKeyToAccount(devnet.privateKey as Hex);
const network = devnet.network as Lightchain['network'];

test('mints an API key from a wallet signature', async () => {
  const http = replayHttp(mint);
  const lc = new Lightchain({ network, account, fetch: http.fetch });

  const created = await lc.createApiKey({ name: 'sdk-test', spendCapWei: 5_000_000_000_000_000_000n });

  assert.equal(created.key, (mint[2].body as { key: string }).key);
  assert.equal(created.scope, 'chat');
  const [challenge, verify, keys] = http.sent;
  assert.equal(new URL(challenge.path, network.apiUrl).searchParams.get('address'), account.address);
  const { message, signature } = verify.body as { message: string; signature: Hex };
  assert.equal(message, (mint[0].body as { message: string }).message);
  assert.equal(await recoverMessageAddress({ message, signature }), account.address);
  assert.equal(keys.headers.get('authorization'), `Bearer ${(mint[1].body as { token: string }).token}`);
  assert.deepEqual(keys.body, { name: 'sdk-test', spendCapWei: '5000000000000000000' });
  http.done();
});

test('refuses to sign a sign-in message for another wallet', async () => {
  const challenge = mint[0].body as { message: string; nonce: string };
  const other = challenge.message.replace(account.address, '0x000000000000000000000000000000000000dEaD');
  const http = replayHttp([{ ...mint[0], body: { ...challenge, message: other } }]);
  const lc = new Lightchain({ network, account, fetch: http.fetch });

  await assert.rejects(lc.createApiKey(), /another address/);
  assert.equal(http.sent.length, 1, 'nothing was signed or sent after the challenge');
});

test('raises a refused key route as a LightchainError with its status and code', async () => {
  const http = replayHttp([mint[0], mint[1], ...keyLimit]);
  const lc = new Lightchain({ network, account, fetch: http.fetch });

  const error = await lc.createApiKey().catch((e: unknown) => e);
  assert.ok(error instanceof LightchainError);
  assert.equal(error.status, 409);
  assert.equal(error.code, 'api_key_limit');
});

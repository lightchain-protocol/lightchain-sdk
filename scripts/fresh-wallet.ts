// Runs an npm script with a wallet made for this run alone, for a test that needs a wallet with no history (one
// that never authorized a delegate) and must still run every night. FUNDER_PRIVATE_KEY's wallet funds it. After the
// script, pass or fail, the fresh wallet withdraws its prepaid balance and sends all it holds back to the funder.
//
//   FUNDER_PRIVATE_KEY=0x... LIGHTCHAIN_MODEL=gemma4:e2b node scripts/fresh-wallet.ts acceptance:per-call
//
// The fresh key exists only in this process and the script's environment. LIGHTCHAIN_FUND_WEI (default 0.11 LCAI:
// acceptance:per-call's 0.1 deposit, plus gas) is what a run killed before the sweep leaves behind. LIGHTCHAIN_NETWORK
// picks the network (default testnet).
import { spawnSync } from 'node:child_process';
import { createPublicClient, createWalletClient, defineChain, formatEther, type Hex, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { networks } from '../src/index.ts';

const { FUNDER_PRIVATE_KEY, ...env } = process.env;
const script = process.argv[2];
if (!script || !FUNDER_PRIVATE_KEY) throw new Error('usage: FUNDER_PRIVATE_KEY=0x... node scripts/fresh-wallet.ts <npm script>');

const network = networks[(env.LIGHTCHAIN_NETWORK ?? 'testnet') as 'mainnet' | 'testnet'];
const chain = defineChain({
  id: network.chainId,
  name: `LightChain ${network.chainId}`,
  nativeCurrency: { name: 'LightChain AI', symbol: 'LCAI', decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
});
const transport = http(network.rpcUrl);
const chainClient = createPublicClient({ chain, transport, pollingInterval: 1_000 });
const funder = createWalletClient({ account: privateKeyToAccount(FUNDER_PRIVATE_KEY as Hex), chain, transport });
const key = generatePrivateKey();
const fresh = createWalletClient({ account: privateKeyToAccount(key), chain, transport });
const mined = async (hash: Hex) => {
  const receipt = await chainClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return hash;
};

const fund = BigInt(env.LIGHTCHAIN_FUND_WEI ?? 11n * 10n ** 16n);
const funded = await mined(await funder.sendTransaction({ to: fresh.account.address, value: fund }));
console.log(`fresh wallet ${fresh.account.address}: ${formatEther(fund)} LCAI from ${funder.account.address} in ${funded}`);

const run = spawnSync('npm', ['run', '-s', script], { stdio: 'inherit', env: { ...env, WALLET_PRIVATE_KEY: key } });

const abi = parseAbi(['function prepaidBalanceOf(address) view returns (uint256)', 'function withdrawBalance(uint256)']);
const address = network.jobRegistry;
const prepaid = await chainClient.readContract({ address, abi, functionName: 'prepaidBalanceOf', args: [fresh.account.address] });
if (prepaid > 0n) {
  const hash = await mined(await fresh.writeContract({ address, abi, functionName: 'withdrawBalance', args: [prepaid] }));
  console.log(`withdrew the prepaid ${formatEther(prepaid)} LCAI in ${hash}`);
}
// A legacy transfer at a fixed gas price costs exactly 21000 * gasPrice, so the rest can go back to the last wei.
const gasPrice = await chainClient.getGasPrice();
const rest = (await chainClient.getBalance({ address: fresh.account.address })) - 21_000n * gasPrice;
if (rest > 0n) {
  const hash = await mined(await fresh.sendTransaction({ to: funder.account.address, value: rest, gas: 21_000n, gasPrice }));
  console.log(`returned ${formatEther(rest)} LCAI to ${funder.account.address} in ${hash}`);
}
process.exit(run.status ?? 1);

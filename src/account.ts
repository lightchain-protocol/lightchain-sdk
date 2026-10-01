import { type Address, encodeAbiParameters, type Hex, type LocalAccount, parseAbi } from 'viem';

/**
 * The LightChainAccount functions and errors the SDK uses, from
 * contracts/src/LightChainAccount.sol and AgentKeys.sol. The errors let viem
 * name a batch's revert: an agent key over its spend cap, a target it may not call.
 */
export const lightChainAccountAbi = parseAbi([
  'function execute(bytes32 mode, bytes executionData) payable',
  'function batchNonce(address signer) view returns (uint256)',
  'function installAgentKey(address key, address[] targets, uint256 spendCap, uint64 expiry)',
  'function revokeAgentKey(address key)',
  'function agentKey(address key) view returns ((uint64 expiry, uint256 remaining, address[] targets))',
  'error AccountUnauthorized(address sender)',
  'error BatchExpired(uint256 deadline)',
  'error InvalidBatchNonce(uint256 expected, uint256 got)',
  'error InvalidAgentKey()',
  'error AgentKeyNotInstalled(address key)',
  'error AgentKeyExpired(address key, uint64 expiry)',
  'error AgentKeyTargetNotAllowed(address key, address target)',
  'error AgentKeySpendCapExceeded(address key, uint256 value, uint256 remaining)',
]);

/** ERC-7821 batch mode: only the account itself may execute it (the owner's own transaction). */
export const BATCH_MODE: Hex = '0x0100000000000000000000000000000000000000000000000000000000000000';
/** ERC-7821 batch mode with opData: a batch its signer signed, which anyone may submit. */
export const SIGNED_BATCH_MODE: Hex = '0x0100000000007821000100000000000000000000000000000000000000000000';

/** How long a signed batch stays valid: it is submitted at once. */
const BATCH_TTL_SECONDS = 600;

export type Call = { to: Address; value: bigint; data: Hex };
export type SignedBatch = { nonce: bigint; deadline: bigint; signature: Hex };

const EXECUTIONS = {
  type: 'tuple[]',
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ],
} as const;

const toExecutions = (calls: Call[]) => calls.map((c) => ({ target: c.to, value: c.value, callData: c.data }));

/** `abi.encode(Execution[])`: a batch's calls as the account decodes them. */
export const encodeCalls = (calls: Call[]): Hex => encodeAbiParameters([EXECUTIONS], [toExecutions(calls)]);

/**
 * Signs `calls` as one of `account`'s batches: EIP-712 `Batch(bytes calls,uint256 nonce,uint256 deadline)`
 * over the account's domain. `nonce` is the signer's next one (`batchNonce(signer)`).
 */
export async function signBatch(signer: LocalAccount, account: Address, chainId: number, calls: Call[], nonce: bigint): Promise<SignedBatch> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + BATCH_TTL_SECONDS);
  const signature = await signer.signTypedData({
    domain: { name: 'LightChainAccount', version: '1', chainId, verifyingContract: account },
    types: {
      Batch: [
        { name: 'calls', type: 'bytes' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Batch',
    message: { calls: encodeCalls(calls), nonce, deadline },
  });
  return { nonce, deadline, signature };
}

/** `execute`'s data in the signed-batch mode: `abi.encode(Execution[] calls, abi.encode(nonce, deadline, signature))`. */
export function signedExecutionData(calls: Call[], { nonce, deadline, signature }: SignedBatch): Hex {
  const opData = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], [nonce, deadline, signature]);
  return encodeAbiParameters([EXECUTIONS, { type: 'bytes' }], [toExecutions(calls), opData]);
}

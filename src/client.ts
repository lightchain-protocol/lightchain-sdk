import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  isAddress,
  isAddressEqual,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { jobRegistryAbi } from './abi.ts';
import { type Network, networks } from './networks.ts';

export type LightchainOptions = {
  /** `mainnet`, `testnet`, or the endpoints of another network (a devnet). */
  network: keyof typeof networks | Network;
  /** The wallet: it signs in to mint keys and pays for the keys it mints. */
  account: LocalAccount;
  /**
   * What one deposit made on a 402 sends, in wei. A 402 asking for more is
   * not paid. Default: the 402's minimum, one job's fee, so every job pays
   * its own deposit; set it higher to deposit for many jobs at once.
   */
  depositWei?: bigint;
  /** Told of every deposit the SDK makes on a 402. */
  onDeposit?: (deposit: Deposit) => void;
  /** The HTTP client for the Developer API; the global fetch by default. */
  fetch?: typeof fetch;
  /** The chain's JSON-RPC transport; HTTP to the network's rpcUrl by default. */
  transport?: Transport;
};

/** A depositAndAuthorize the SDK sent on a 402. */
export type Deposit = { hash: Hex; value: bigint; delegate: Address };

/** The wallet's prepaid balance; with a delegate, what that delegate may spend of it. */
export type Balance = { balance: bigint; authorized?: boolean; allowance?: bigint };

/** What a key's owner may set when minting it; wei amounts as bigint. */
export type CreateApiKeyInput = {
  name?: string;
  /** `chat` (the default) may run completions; `read` may only list models. */
  scope?: 'chat' | 'read';
  /** What the key may spend in its lifetime. No cap if omitted. */
  spendCapWei?: bigint;
  requestsPerMinute?: number;
  concurrentSessions?: number;
  dailySpendCapWei?: bigint;
};

/** A key as the API lists it: never the key itself. Wei amounts are decimal strings. */
export type ApiKey = {
  id: string;
  prefix: string;
  name: string | null;
  scope: 'chat' | 'read';
  spendCapWei: string | null;
  spentWei: string;
  limits: { requestsPerMinute: number; concurrentSessions: number; dailySpendCapWei: string | null };
  limitHits: Record<string, number>;
  createdAt: string;
  revokedAt: string | null;
};

/** The on-chain job behind a completion: its `lightchain` field, and the `x-lightchain` header as JSON. */
export type LightchainJob = { job_id: string; session_id: string; tx_hash: Hex; worker: Address };

/** The `delegate` way to pay a 402, as the server sends it: untrusted until checked. */
type DelegateAccept = {
  scheme: 'delegate';
  chain_id?: unknown;
  payer?: unknown;
  delegate?: unknown;
  instruction?: { contract?: unknown; function?: unknown; args?: unknown[]; minimum_value_wei?: unknown };
};

/** A /v1 402 body: OpenAI's error, with the ways to pay in `accepts`. */
type PaymentRequired = { error?: { message?: string; code?: string; accepts?: DelegateAccept[] } };

/** Whether `value`, as the server sent it, is `address`. */
function sameAddress(value: unknown, address: Address): boolean {
  return typeof value === 'string' && isAddress(value) && isAddressEqual(value, address);
}

/** A key refused by the Developer API: the HTTP status, the body's code, and the body. */
export class LightchainError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    // The key routes answer { error, message }; /v1 answers OpenAI's { error: { message, code } }.
    const answer = body as { error?: string | { code?: string | null; message?: string }; message?: string } | undefined;
    const error = answer?.error;
    super((typeof error === 'object' ? error.message : answer?.message) ?? `HTTP ${status}`);
    this.name = 'LightchainError';
    this.status = status;
    this.code = (typeof error === 'object' ? error.code : error) ?? null;
    this.body = body;
  }
}

/** Keys and money for the LightChain AI Developer API. Completions go through the OpenAI SDK at `baseURL`. */
export class Lightchain {
  readonly network: Network;
  readonly address: Address;
  /** The OpenAI-compatible base URL, for the OpenAI SDK's `baseURL`. */
  readonly baseURL: string;
  readonly #account: LocalAccount;
  readonly #fetch: typeof fetch;
  readonly #publicClient: PublicClient;
  readonly #walletClient: WalletClient<Transport, Chain, LocalAccount>;
  readonly #depositWei: bigint | undefined;
  readonly #onDeposit: ((deposit: Deposit) => void) | undefined;
  /** The last deposit sent: the next one waits for it. */
  #lastDeposit: Promise<unknown> = Promise.resolve();

  constructor(options: LightchainOptions) {
    this.network = typeof options.network === 'string' ? networks[options.network] : options.network;
    this.#account = options.account;
    this.address = options.account.address;
    this.baseURL = `${this.network.apiUrl}/v1`;
    // Called unbound: a browser's fetch refuses any other `this`.
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
    this.#depositWei = options.depositWei;
    this.#onDeposit = options.onDeposit;
    const chain = defineChain({
      id: this.network.chainId,
      name: `LightChain ${this.network.chainId}`,
      nativeCurrency: { name: 'LightChain AI', symbol: 'LCAI', decimals: 18 },
      rpcUrls: { default: { http: [this.network.rpcUrl] } },
    });
    const transport = options.transport ?? http(this.network.rpcUrl);
    // The chains make a block every 2 s; viem's default 4 s poll would idle through two.
    this.#publicClient = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.#walletClient = createWalletClient({ account: options.account, chain, transport });
  }

  /**
   * fetch, paying a 402 by itself. When the Developer API answers that the
   * wallet behind the key has not paid (a `delegate` entry in the 402's
   * `accepts`; other schemes are left alone), it sends that depositAndAuthorize
   * from the account, once the 402 checks out against this network, and sends
   * the request again. Every other answer comes back as it is, a 402 for a
   * limit the key's owner set included. A 402 it does not pay comes back with
   * the reason prepended to `error.message`. Give it to the OpenAI SDK as `fetch`.
   *
   * Each 402 pays its own deposit, so 402s that arrive together each pay one:
   * with a large depositWei, calls made together before the first deposit
   * lands deposit more than one of them needs. It stays in the wallet's
   * prepaid balance.
   */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const again = input instanceof Request ? input.clone() : input;
    const response = await this.#fetch(input, init);
    if (response.status !== 402) return response;
    const body = (await response.clone().json().catch(() => null)) as PaymentRequired | null;
    const accept = body?.error?.accepts?.find((a) => a?.scheme === 'delegate');
    if (!accept) return response;
    await response.body?.cancel();
    try {
      const deposit = this.#checkDelegateOffer(accept);
      const hash = await this.depositAndAuthorize(deposit.delegate, deposit.value);
      this.#onDeposit?.({ hash, ...deposit });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const refused = { ...body, error: { ...body!.error, message: `Not paid by the SDK: ${reason} ${body!.error!.message ?? ''}`.trim() } };
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(refused), { status: 402, headers });
    }
    // ponytail: sent again once. A 402 on that retry (the fee rose meanwhile)
    // comes back to the caller; loop, with a bound, if that shows up.
    return this.#fetch(again, init);
  };

  /**
   * Sends JobRegistry.depositAndAuthorize(delegate) with `value`: adds it to
   * the wallet's prepaid balance, authorizes the delegate (the API's signer)
   * to submit jobs for the wallet, and raises its allowance by `value`.
   * Resolves with the transaction hash once it succeeded on chain.
   */
  depositAndAuthorize(delegate: Address, value: bigint): Promise<Hex> {
    // One at a time: each transaction reads the account's nonce, so two sent
    // together would take the same one.
    const sent = this.#lastDeposit.then(async () => {
      const hash = await this.#walletClient.writeContract({
        address: this.network.jobRegistry,
        abi: jobRegistryAbi,
        functionName: 'depositAndAuthorize',
        args: [delegate],
        value,
      });
      const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`depositAndAuthorize ${hash} reverted.`);
      return hash;
    });
    this.#lastDeposit = sent.catch(() => undefined);
    return sent;
  }

  /** The wallet's prepaid balance, read from the chain; with `delegate`, also its authorization and allowance. */
  async getBalance(delegate?: Address): Promise<Balance> {
    const registry = { address: this.network.jobRegistry, abi: jobRegistryAbi } as const;
    const readBalance = this.#publicClient.readContract({ ...registry, functionName: 'prepaidBalanceOf', args: [this.address] });
    if (!delegate) return { balance: await readBalance };
    const [balance, authorized, allowance] = await Promise.all([
      readBalance,
      this.#publicClient.readContract({ ...registry, functionName: 'isDelegateAuthorized', args: [this.address, delegate] }),
      this.#publicClient.readContract({ ...registry, functionName: 'delegateAllowance', args: [this.address, delegate] }),
    ]);
    return { balance, authorized, allowance };
  }

  /** The deposit a 402's delegate offer asks for, once it names this network's JobRegistry and this wallet. */
  #checkDelegateOffer(accept: DelegateAccept): { delegate: Address; value: bigint } {
    const { chain_id, payer, delegate, instruction } = accept;
    if (chain_id !== this.network.chainId) throw new Error(`the 402 is for chain ${chain_id}, not ${this.network.chainId}.`);
    if (!sameAddress(payer, this.address)) throw new Error(`the key belongs to another wallet (${payer}), not ${this.address}.`);
    if (!sameAddress(instruction?.contract, this.network.jobRegistry)) {
      throw new Error(`the 402 names ${instruction?.contract}, not this network's JobRegistry ${this.network.jobRegistry}.`);
    }
    const named = typeof delegate === 'string' && isAddress(delegate) && sameAddress(instruction?.args?.[0], delegate);
    if (!named || instruction?.function !== 'depositAndAuthorize(address)') {
      throw new Error('the 402 does not name a depositAndAuthorize of its delegate.');
    }
    const wei = instruction.minimum_value_wei;
    if (typeof wei !== 'string' || !/^[0-9]+$/.test(wei)) throw new Error(`the 402's minimum ${wei} is not an amount in wei.`);
    const minimum = BigInt(wei);
    const to = delegate as Address; // checked above
    if (this.#depositWei === undefined) return { delegate: to, value: minimum };
    if (minimum > this.#depositWei) throw new Error(`the 402 asks for ${minimum} wei, more than depositWei (${this.#depositWei}).`);
    return { delegate: to, value: this.#depositWei };
  }

  /**
   * Signs in with the wallet (Sign-In with Ethereum: a message signature, no
   * gas) and returns the token the key routes take as `Authorization: Bearer`.
   * It lasts an hour.
   */
  async signIn(): Promise<string> {
    const { message } = await this.#api<{ message: string }>(`/api/auth/challenge?address=${this.address}`);
    // The server writes the message; sign only a sign-in for this wallet.
    const { address } = parseSiweMessage(message);
    if (!address || !isAddressEqual(address, this.address)) {
      throw new Error(`The sign-in message is for another address (${address}), not ${this.address}; not signing it.`);
    }
    const signature = await this.#account.signMessage({ message });
    const { token } = await this.#api<{ token: string }>('/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });
    return token;
  }

  /**
   * Mints an API key bound to the wallet, signing in first. `key` is in this
   * answer only: store it like a password.
   */
  async createApiKey(input: CreateApiKeyInput = {}): Promise<ApiKey & { key: string }> {
    const token = await this.signIn();
    return this.#api('/api/api-keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // The API takes wei as decimal strings.
      body: JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    });
  }

  async #api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.#fetch(`${this.network.apiUrl}${path}`, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new LightchainError(response.status, body);
    return body as T;
  }
}

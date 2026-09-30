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

/** A key refused by the Developer API: the HTTP status, the body's code, and the body. */
export class LightchainError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    // The key routes answer { error, message }; /v1 answers OpenAI's { error: { message, code } }.
    const b = body as { error?: string | { code?: string | null; message?: string }; message?: string } | undefined;
    const error = b?.error;
    super((typeof error === 'object' ? error.message : b?.message) ?? `HTTP ${status}`);
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
  readonly #chain: PublicClient;
  readonly #wallet: WalletClient<Transport, Chain, LocalAccount>;
  readonly #depositWei: bigint | undefined;
  readonly #onDeposit: ((deposit: Deposit) => void) | undefined;
  /** The deposit in flight: 402s that arrive meanwhile wait for it instead of paying again. */
  #paying: Promise<void> | undefined;

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
    this.#chain = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.#wallet = createWalletClient({ account: options.account, chain, transport });
  }

  /**
   * fetch, paying a 402 by itself. When the Developer API answers that the
   * wallet behind the key has not paid (a `delegate` entry in the 402's
   * `accepts`), it sends that depositAndAuthorize from the account, once the
   * 402 checks out against this network, and sends the request again, once.
   * Every other answer comes back as it is, a 402 for a limit the key's owner
   * set included. A 402 it does not pay comes back with the reason prepended
   * to `error.message`. Give it to the OpenAI SDK as `fetch`.
   */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const again = input instanceof Request ? input.clone() : input;
    const response = await this.#fetch(input, init);
    if (response.status !== 402) return response;
    const body = (await response.clone().json().catch(() => null)) as PaymentRequired | null;
    const accept = body?.error?.accepts?.find((a) => a?.scheme === 'delegate');
    if (!accept) return response;
    try {
      await this.#pay(this.#checkDelegateOffer(accept));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const refused = { ...body, error: { ...body!.error, message: `Not paid by the SDK: ${reason} ${body!.error!.message ?? ''}`.trim() } };
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(refused), { status: 402, headers });
    }
    return this.#fetch(again, init);
  };

  /**
   * Sends JobRegistry.depositAndAuthorize(delegate) with `value`: adds it to
   * the wallet's prepaid balance, authorizes the delegate (the API's signer)
   * to submit jobs for the wallet, and raises its allowance by `value`.
   * Resolves with the transaction hash once it succeeded on chain.
   */
  async depositAndAuthorize(delegate: Address, value: bigint): Promise<Hex> {
    const hash = await this.#wallet.writeContract({
      address: this.network.jobRegistry,
      abi: jobRegistryAbi,
      functionName: 'depositAndAuthorize',
      args: [delegate],
      value,
    });
    const receipt = await this.#chain.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`depositAndAuthorize ${hash} reverted.`);
    return hash;
  }

  /** The wallet's prepaid balance, read from the chain; with `delegate`, also its authorization and allowance. */
  async getBalance(delegate?: Address): Promise<Balance> {
    const registry = { address: this.network.jobRegistry, abi: jobRegistryAbi } as const;
    const balance = this.#chain.readContract({ ...registry, functionName: 'prepaidBalanceOf', args: [this.address] });
    if (!delegate) return { balance: await balance };
    const [b, authorized, allowance] = await Promise.all([
      balance,
      this.#chain.readContract({ ...registry, functionName: 'isDelegateAuthorized', args: [this.address, delegate] }),
      this.#chain.readContract({ ...registry, functionName: 'delegateAllowance', args: [this.address, delegate] }),
    ]);
    return { balance: b, authorized, allowance };
  }

  /** The deposit a 402's delegate offer asks for, once it names this network's JobRegistry and this wallet. */
  #checkDelegateOffer(accept: DelegateAccept): { delegate: Address; value: bigint } {
    const { chain_id, payer, delegate, instruction: i } = accept;
    if (chain_id !== this.network.chainId) throw new Error(`the 402 is for chain ${chain_id}, not ${this.network.chainId}.`);
    if (typeof payer !== 'string' || !isAddress(payer) || !isAddressEqual(payer, this.address)) {
      throw new Error(`the key belongs to another wallet (${payer}), not ${this.address}.`);
    }
    if (typeof i?.contract !== 'string' || !isAddress(i.contract) || !isAddressEqual(i.contract, this.network.jobRegistry)) {
      throw new Error(`the 402 names ${i?.contract}, not this network's JobRegistry ${this.network.jobRegistry}.`);
    }
    if (i.function !== 'depositAndAuthorize(address)' || typeof delegate !== 'string' || !isAddress(delegate) || i.args?.[0] !== delegate) {
      throw new Error('the 402 does not name a depositAndAuthorize of its delegate.');
    }
    if (typeof i.minimum_value_wei !== 'string' || !/^[0-9]+$/.test(i.minimum_value_wei)) {
      throw new Error(`the 402's minimum ${i.minimum_value_wei} is not an amount in wei.`);
    }
    const minimum = BigInt(i.minimum_value_wei);
    if (this.#depositWei === undefined) return { delegate, value: minimum };
    if (minimum > this.#depositWei) throw new Error(`the 402 asks for ${minimum} wei, more than depositWei (${this.#depositWei}).`);
    return { delegate, value: this.#depositWei };
  }

  #pay(deposit: { delegate: Address; value: bigint }): Promise<void> {
    this.#paying ??= this.depositAndAuthorize(deposit.delegate, deposit.value)
      .then((hash) => this.#onDeposit?.({ hash, ...deposit }))
      .finally(() => {
        this.#paying = undefined;
      });
    return this.#paying;
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

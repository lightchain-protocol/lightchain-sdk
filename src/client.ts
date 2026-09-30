import {
  type Address,
  bytesToHex,
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
  /** The HTTP client for the Developer API; the global fetch by default. */
  fetch?: typeof fetch;
  /** The chain's JSON-RPC transport; HTTP to the network's rpcUrl by default. */
  transport?: Transport;
} & (DelegatePayment | X402Payment);

/** The default: `fetch` pays a 402 by authorizing the API's delegate, with a depositAndAuthorize transaction. */
type DelegatePayment = {
  payment?: 'delegate';
  /**
   * What one deposit made on a 402 sends, in wei. A 402 asking for more is
   * not paid. Default: the 402's minimum, one job's fee, so every job pays
   * its own deposit; set it higher to deposit for many jobs at once.
   */
  depositWei?: bigint;
  /** Told of every deposit the SDK makes on a 402. */
  onDeposit?: (deposit: Deposit) => void;
};

/**
 * `fetch` pays each 402 with an x402 payment: a debit authorization the
 * account signs against its own prepaid balance. No transaction, no delegate.
 */
type X402Payment = {
  payment: 'x402';
  /** The most one request may pay, in wei. A 402 asking for more is not paid. */
  maxPaymentWei: bigint;
  /** Told of every x402 payment the server settled. */
  onPayment?: (payment: Payment) => void;
};

/** A depositAndAuthorize the SDK sent on a 402. */
export type Deposit = { hash: Hex; value: bigint; delegate: Address };

/** An x402 payment the SDK signed on a 402: the settlement transaction, which submitted the job, and the fee it debited. */
export type Payment = { hash: Hex; amount: bigint };

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

/** x402 PaymentRequirements of the `prepaid-debit` scheme, as the server sends them: untrusted until checked. */
type X402Accept = {
  scheme: 'prepaid-debit';
  network?: unknown;
  amount?: unknown;
  asset?: unknown;
  payTo?: unknown;
  maxTimeoutSeconds?: unknown;
  extra?: { name?: unknown; version?: unknown; facilitatorAddress?: unknown };
};

/** A /v1 402 body: OpenAI's error, with the ways to pay in `accepts`. */
type PaymentRequired = { error?: { message?: string; code?: string; accepts?: (DelegateAccept | X402Accept)[] } };

/** LightChain's x402 scheme (docs/x402/lightchain-scheme.md in the orchestrator): its EIP-712 domain and type. */
const X402_SCHEME = 'prepaid-debit';
const DEBIT_DOMAIN = { name: 'LightChain JobRegistry', version: '1' } as const;
const DEBIT_AUTHORIZATION = {
  DebitAuthorization: [
    { name: 'payer', type: 'address' },
    { name: 'payTo', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
/** The longest a signed authorization may stay valid: the scheme asks for 120 s. */
const MAX_TIMEOUT_SECONDS = 600;

/** x402 headers carry base64 of UTF-8 JSON. */
const toBase64 = (json: string) => btoa(String.fromCharCode(...new TextEncoder().encode(json)));
const fromBase64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));

/** Whether `value`, as the server sent it, is `address`. */
function sameAddress(value: unknown, address: Address): boolean {
  return typeof value === 'string' && isAddress(value) && isAddressEqual(value, address);
}

/** The settlement a PAYMENT-RESPONSE header reports, if it reports one that succeeded. */
function settlementOf(response: Response): Payment | undefined {
  const header = response.headers.get('payment-response');
  if (!header) return undefined;
  try {
    const { success, transaction, amount } = JSON.parse(fromBase64(header));
    if (success === true && /^0x[0-9a-fA-F]{64}$/.test(transaction) && /^[0-9]+$/.test(amount)) {
      return { hash: transaction, amount: BigInt(amount) };
    }
  } catch {
    // An unreadable header leaves the answer as it is.
  }
  return undefined;
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
  /** Set in x402 mode only: then a 402 is paid by signing, never by a transaction. */
  readonly #maxPaymentWei: bigint | undefined;
  readonly #onPayment: ((payment: Payment) => void) | undefined;
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
    if (options.payment === 'x402') {
      // No default: what a 402 may take is the builder's call.
      if (typeof options.maxPaymentWei !== 'bigint' || options.maxPaymentWei <= 0n) {
        throw new Error('payment "x402" needs maxPaymentWei: the most one request may pay, in wei.');
      }
      this.#maxPaymentWei = options.maxPaymentWei;
      this.#onPayment = options.onPayment;
    } else if (options.payment === undefined || options.payment === 'delegate') {
      this.#depositWei = options.depositWei;
      this.#onDeposit = options.onDeposit;
    } else {
      throw new Error(`payment is "delegate" or "x402", not ${JSON.stringify(options.payment)}.`);
    }
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
   * fetch, paying a 402 by itself, the way `payment` says. Give it to the
   * OpenAI SDK as `fetch`.
   *
   * `delegate` (the default): when the Developer API answers that the wallet
   * behind the key has not paid (a `delegate` entry in the 402's `accepts`), it
   * sends that depositAndAuthorize from the account, once the 402 checks out
   * against this network, and sends the request again.
   *
   * `x402`: when the 402 lists the `prepaid-debit` requirements, it signs a
   * debit authorization for their amount against the account's prepaid
   * balance, once they check out against this network and maxPaymentWei, and
   * sends the request again with it in a PAYMENT-SIGNATURE header. It never
   * sends a transaction.
   *
   * Every other answer comes back as it is, a 402 for a limit the key's owner
   * set included. A 402 it does not pay comes back with the reason prepended
   * to `error.message`.
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
    const x402 = this.#maxPaymentWei !== undefined;
    const accepts = body?.error?.accepts ?? [];
    const accept = accepts.find((a) => a?.scheme === (x402 ? X402_SCHEME : 'delegate'));
    // In x402 mode a 402 that only offers the delegate way is a missing payment too: say why it stays unpaid.
    if (!accept && !(x402 && accepts.some((a) => a?.scheme === 'delegate'))) return response;
    await response.body?.cancel();
    let payment: string | undefined;
    try {
      if (!accept) throw new Error('payment is "x402", and the 402 offers no prepaid-debit payment.');
      if (x402) payment = await this.#signPayment(accept as X402Accept);
      else {
        const deposit = this.#checkDelegateOffer(accept as DelegateAccept);
        const hash = await this.depositAndAuthorize(deposit.delegate, deposit.value);
        this.#onDeposit?.({ hash, ...deposit });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const refused = { ...body, error: { ...body!.error, message: `Not paid by the SDK: ${reason} ${body!.error!.message ?? ''}`.trim() } };
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(refused), { status: 402, headers });
    }
    // ponytail: sent again once. A 402 on that retry (the fee rose meanwhile)
    // comes back to the caller; loop, with a bound, if that shows up.
    if (payment === undefined) return this.#fetch(again, init);
    // init's headers replace a Request's own, so they carry the payment either way.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('payment-signature', payment);
    const paid = await this.#fetch(again, { ...init, headers });
    const settled = settlementOf(paid);
    if (settled) this.#onPayment?.(settled);
    return paid;
  };

  /**
   * Sends JobRegistry.depositAndAuthorize(delegate) with `value`: adds it to
   * the wallet's prepaid balance, authorizes the delegate (the API's signer)
   * to submit jobs for the wallet, and raises its allowance by `value`.
   * Resolves with the transaction hash once it succeeded on chain.
   */
  depositAndAuthorize(delegate: Address, value: bigint): Promise<Hex> {
    const registry = { address: this.network.jobRegistry, abi: jobRegistryAbi } as const;
    return this.#send('depositAndAuthorize', () =>
      this.#walletClient.writeContract({ ...registry, functionName: 'depositAndAuthorize', args: [delegate], value }),
    );
  }

  /**
   * Sends JobRegistry.deposit() with `value`: adds it to the wallet's prepaid
   * balance and authorizes nobody. x402 payments are paid from it. Resolves
   * with the transaction hash once it succeeded on chain.
   */
  deposit(value: bigint): Promise<Hex> {
    const registry = { address: this.network.jobRegistry, abi: jobRegistryAbi } as const;
    return this.#send('deposit', () => this.#walletClient.writeContract({ ...registry, functionName: 'deposit', value }));
  }

  /** Sends a transaction once the one before it is done, and waits for it to succeed. */
  #send(name: string, write: () => Promise<Hex>): Promise<Hex> {
    // One at a time: each transaction reads the account's nonce, so two sent
    // together would take the same one.
    const sent = this.#lastDeposit.then(async () => {
      const hash = await write();
      const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${name} ${hash} reverted.`);
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
   * The PAYMENT-SIGNATURE for a 402's prepaid-debit requirements, once they
   * name this network, its JobRegistry and the scheme's domain, and ask for
   * at most maxPaymentWei: a debit authorization of that amount, valid for
   * maxTimeoutSeconds, with a fresh random nonce.
   */
  async #signPayment(accept: X402Accept): Promise<string> {
    const { network, asset, amount, payTo, maxTimeoutSeconds: timeout, extra } = accept;
    const chain = `eip155:${this.network.chainId}`;
    if (network !== chain) throw new Error(`the 402 is for network ${network}, not ${chain}.`);
    if (!sameAddress(asset, this.network.jobRegistry)) {
      throw new Error(`the 402 names ${asset}, not this network's JobRegistry ${this.network.jobRegistry}.`);
    }
    if (extra?.name !== DEBIT_DOMAIN.name || extra.version !== DEBIT_DOMAIN.version) {
      throw new Error(`the 402 names the domain "${extra?.name}" version ${extra?.version}, not "${DEBIT_DOMAIN.name}" version ${DEBIT_DOMAIN.version}.`);
    }
    const facilitator = extra.facilitatorAddress;
    if (typeof payTo !== 'string' || !isAddress(payTo) || typeof facilitator !== 'string' || !isAddress(facilitator)) {
      throw new Error('the 402 does not name a payTo and a facilitatorAddress.');
    }
    if (typeof amount !== 'string' || !/^[0-9]+$/.test(amount)) throw new Error(`the 402's amount ${amount} is not an amount in wei.`);
    const maxAmount = BigInt(amount);
    if (maxAmount > this.#maxPaymentWei!) throw new Error(`the 402 asks for ${maxAmount} wei, more than maxPaymentWei (${this.#maxPaymentWei}).`);
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`the 402's maxTimeoutSeconds ${timeout} is not between 1 and ${MAX_TIMEOUT_SECONDS}.`);
    }
    // The cap is the amount asked, not maxPaymentWei: the server debits the fee, at most the cap.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + timeout);
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const message = { payer: this.address, payTo, facilitator, maxAmount, deadline, nonce };
    const signature = await this.#account.signTypedData({
      domain: { ...DEBIT_DOMAIN, chainId: this.network.chainId, verifyingContract: this.network.jobRegistry },
      types: DEBIT_AUTHORIZATION,
      primaryType: 'DebitAuthorization',
      message,
    });
    const authorization = { ...message, maxAmount: maxAmount.toString(), deadline: deadline.toString() };
    // `accepted` is the requirements verbatim: the server compares them field by field.
    return toBase64(JSON.stringify({ x402Version: 2, accepted: accept, payload: { signature, authorization } }));
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

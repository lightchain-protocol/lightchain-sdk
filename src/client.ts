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
import { jobRegistryAbi } from './abi.ts';
import { type Network, networks } from './networks.ts';

export type LightchainOptions = {
  /** `mainnet`, `testnet`, or the endpoints of another network (a devnet). */
  network: keyof typeof networks | Network;
  /** The HTTP client for the Developer API; the global fetch by default. */
  fetch?: typeof fetch;
  /** The chain's JSON-RPC transport; HTTP to the network's rpcUrl by default. */
  transport?: Transport;
} & (DelegatePayment | X402Payment);

/** The API key (`lcai_...`), created in the chat under Developer, API keys. `fetch` sends it with every call. */
type ApiKey = string;

/**
 * The default. With an account, `fetch` pays a 402 by authorizing the API's
 * delegate, with a depositAndAuthorize transaction; without one, the 402
 * comes back to the caller, and the key's owner tops up in the chat.
 */
type DelegatePayment = {
  payment?: 'delegate';
  apiKey: ApiKey;
  /** A viem local account: the wallet behind the key, which pays a 402 by itself. */
  account?: LocalAccount;
  /**
   * What one deposit made on a 402 sends, in wei. A 402 asking for more is
   * not paid. Default: the 402's minimum, one job's fee, so every job pays
   * its own deposit; set it higher to deposit for many jobs at once.
   */
  depositWei?: bigint;
  /** Told of every deposit the SDK makes on a 402. */
  onDeposit?: (deposit: Deposit) => void;
  maxPaymentWei?: never;
  onPayment?: never;
  keyless?: never;
};

/**
 * `fetch` pays each 402 with an x402 payment: a debit authorization the
 * account signs against its own prepaid balance. No transaction, no delegate.
 */
type X402Payment = {
  payment: 'x402';
  /** A viem local account: it signs every payment. */
  account: LocalAccount;
  /** The most one request may pay, in wei. A 402 asking for more is not paid. */
  maxPaymentWei: bigint;
  /** Told of every x402 payment the server settled. */
  onPayment?: (payment: Payment) => void;
  depositWei?: never;
  onDeposit?: never;
} & (
  | { apiKey: ApiKey; keyless?: false }
  | {
      /**
       * Call with no API key: `fetch` drops the Authorization header, so the
       * payment alone pays, and the API holds the account, as payer, to its
       * per-payer limits.
       */
      keyless: true;
      apiKey?: never;
    }
);

/** A depositAndAuthorize the SDK sent on a 402. */
export type Deposit = { hash: Hex; value: bigint; delegate: Address };

/** An x402 payment the SDK signed on a 402: the settlement transaction, which submitted the job, and the fee it debited. */
export type Payment = { hash: Hex; amount: bigint };

/** The wallet's prepaid balance; with a delegate, what that delegate may spend of it. */
export type Balance = { balance: bigint; authorized?: boolean; allowance?: bigint };

/**
 * The on-chain job behind a completion: its `lightchain` field, the
 * `x-lightchain` header as JSON, and a stream's last chunk. `dropped_messages`:
 * how many of the oldest messages the job left out to fit what one job
 * carries; absent when it carried them all.
 */
export type LightchainJob = { job_id: string; session_id: string; tx_hash: Hex; worker: Address; dropped_messages?: number };

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

/** An API key and its money, for the LightChain AI Developer API. Completions go through the OpenAI SDK at `baseURL`. */
export class Lightchain {
  readonly network: Network;
  /** The account's address, if there is an account. */
  readonly address: Address | undefined;
  /** The OpenAI-compatible base URL, for the OpenAI SDK's `baseURL`. */
  readonly baseURL: string;
  /** The API key, for the OpenAI SDK's `apiKey`; keyless, a placeholder that `fetch` never sends. */
  readonly apiKey: string;
  readonly #account: LocalAccount | undefined;
  readonly #fetch: typeof fetch;
  readonly #publicClient: PublicClient;
  readonly #walletClient: WalletClient<Transport, Chain, LocalAccount> | undefined;
  readonly #registry: { address: Address; abi: typeof jobRegistryAbi };
  /** How a 402 is paid: by a transaction (delegate) or by a signature (x402), never both. */
  readonly #payment: 'delegate' | 'x402';
  readonly #depositWei: bigint | undefined;
  readonly #onDeposit: ((deposit: Deposit) => void) | undefined;
  readonly #maxPaymentWei: bigint = 0n;
  readonly #onPayment: ((payment: Payment) => void) | undefined;
  readonly #keyless: boolean = false;
  /** The last deposit sent: the next one waits for it. */
  #lastDeposit: Promise<unknown> = Promise.resolve();

  constructor(options: LightchainOptions) {
    this.network = typeof options.network === 'string' ? networks[options.network] : options.network;
    this.#account = options.account;
    this.address = options.account?.address;
    this.baseURL = `${this.network.apiUrl}/v1`;
    // Called unbound: a browser's fetch refuses any other `this`.
    const fetch = options.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => fetch(input, init);
    this.#registry = { address: this.network.jobRegistry, abi: jobRegistryAbi };
    // Who needs what: every mode takes apiKey, but x402 with keyless; x402
    // needs account, to sign; the delegate mode takes one to pay its 402s.
    // An option that would be silently ignored is refused.
    const given = (names: string[]) => names.filter((n) => (options as Record<string, unknown>)[n] !== undefined);
    if (options.payment === 'x402') {
      if (given(['depositWei', 'onDeposit']).length) throw new Error('depositWei and onDeposit belong to payment "delegate".');
      if (!options.account) throw new Error('payment "x402" needs account: it signs each payment.');
      // No default: what a 402 may take is the builder's call.
      if (typeof options.maxPaymentWei !== 'bigint' || options.maxPaymentWei <= 0n) {
        throw new Error('payment "x402" needs maxPaymentWei: the most one request may pay, in wei.');
      }
      this.#maxPaymentWei = options.maxPaymentWei;
      this.#onPayment = options.onPayment;
      this.#keyless = options.keyless === true;
      if (this.#keyless === (options.apiKey !== undefined)) throw new Error('payment "x402" takes apiKey or keyless: true, one of the two.');
    } else if (options.payment === undefined || options.payment === 'delegate') {
      if (given(['maxPaymentWei', 'onPayment', 'keyless']).length) {
        throw new Error('maxPaymentWei, onPayment and keyless belong to payment "x402".');
      }
      if (!options.account && given(['depositWei', 'onDeposit']).length) {
        throw new Error('depositWei and onDeposit need account: the wallet that deposits on a 402.');
      }
      this.#depositWei = options.depositWei;
      this.#onDeposit = options.onDeposit;
    } else {
      throw new Error(`payment is "delegate" or "x402", not ${JSON.stringify(options.payment)}.`);
    }
    this.#payment = options.payment ?? 'delegate';
    if (!this.#keyless && (typeof options.apiKey !== 'string' || !options.apiKey)) {
      throw new Error('needs apiKey: a key created in the chat, under Developer, API keys.');
    }
    // The OpenAI SDK insists on some apiKey.
    this.apiKey = options.apiKey ?? 'keyless';
    const chain = defineChain({
      id: this.network.chainId,
      name: `LightChain ${this.network.chainId}`,
      nativeCurrency: { name: 'LightChain AI', symbol: 'LCAI', decimals: 18 },
      rpcUrls: { default: { http: [this.network.rpcUrl] } },
    });
    const transport = options.transport ?? http(this.network.rpcUrl);
    // The chains make a block every 2 s; viem's default 4 s poll would idle through two.
    this.#publicClient = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.#walletClient = options.account && createWalletClient({ account: options.account, chain, transport });
  }

  /**
   * fetch, sending the API key as `Authorization: Bearer` and, given an
   * account, paying a 402 by itself, the way `payment` says. Give it to the
   * OpenAI SDK as `fetch`.
   *
   * `delegate` (the default): when the Developer API answers that the wallet
   * behind the key has not paid (a `delegate` entry in the 402's `accepts`), it
   * sends that depositAndAuthorize from the account, once the 402 checks out
   * against this network, and sends the request again. With no account, the
   * 402 comes back as it is.
   *
   * `x402`: when the 402 lists the `prepaid-debit` requirements, it signs a
   * debit authorization for their amount against the account's prepaid
   * balance, once they check out against this network and maxPaymentWei, and
   * sends the request again with it in a PAYMENT-SIGNATURE header. It never
   * sends a transaction.
   *
   * With `keyless`, no request carries an Authorization header.
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
    // init's headers replace a Request's own, so this sets the key, or drops it, either way.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (this.#keyless) headers.delete('authorization');
    else headers.set('authorization', `Bearer ${this.apiKey}`);
    init = { ...init, headers };
    const again = input instanceof Request ? input.clone() : input;
    const response = await this.#fetch(input, init);
    const account = this.#account;
    // No account, nothing to pay with: the 402 goes to the caller, and a human tops up in the chat.
    if (response.status !== 402 || !account) return response;
    const body = (await response.clone().json().catch(() => null)) as PaymentRequired | null;
    const x402 = this.#payment === 'x402';
    const accepts = body?.error?.accepts ?? [];
    const accept = accepts.find((a) => a?.scheme === (x402 ? X402_SCHEME : 'delegate'));
    // In x402 mode a 402 that only offers the delegate way is a missing payment too: say why it stays unpaid.
    if (!accept && !(x402 && accepts.some((a) => a?.scheme === 'delegate'))) return response;
    await response.body?.cancel();
    let payment = '';
    try {
      if (!accept) throw new Error('payment is "x402", and the 402 offers no prepaid-debit payment.');
      if (x402) payment = await this.#signPayment(account, accept as X402Accept);
      else {
        const deposit = this.#checkDelegateOffer(account.address, accept as DelegateAccept);
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
    if (!x402) return this.#fetch(again, init);
    headers.set('payment-signature', payment);
    const paid = await this.#fetch(again, init);
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
    return this.#send('depositAndAuthorize', (wallet) =>
      wallet.writeContract({ ...this.#registry, functionName: 'depositAndAuthorize', args: [delegate], value }),
    );
  }

  /**
   * Sends JobRegistry.deposit() with `value`: adds it to the wallet's prepaid
   * balance and authorizes nobody. x402 payments are paid from it. Resolves
   * with the transaction hash once it succeeded on chain.
   */
  deposit(value: bigint): Promise<Hex> {
    return this.#send('deposit', (wallet) => wallet.writeContract({ ...this.#registry, functionName: 'deposit', value }));
  }

  /** Sends a transaction once the one before it is done, and waits for it to succeed. */
  #send(name: string, write: (wallet: WalletClient<Transport, Chain, LocalAccount>) => Promise<Hex>): Promise<Hex> {
    const wallet = this.#walletClient;
    if (!wallet) return Promise.reject(new Error(`${name} needs account: the wallet that sends it.`));
    // One at a time: each transaction reads the account's nonce, so two sent
    // together would take the same one.
    const sent = this.#lastDeposit.then(async () => {
      const hash = await write(wallet);
      const receipt = await this.#publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${name} ${hash} reverted.`);
      return hash;
    });
    this.#lastDeposit = sent.catch(() => undefined);
    return sent;
  }

  /** The account's prepaid balance, read from the chain; with `delegate`, also its authorization and allowance. */
  async getBalance(delegate?: Address): Promise<Balance> {
    const { address } = this;
    if (!address) throw new Error('getBalance needs account: the wallet whose balance it reads.');
    const registry = this.#registry;
    const readBalance = this.#publicClient.readContract({ ...registry, functionName: 'prepaidBalanceOf', args: [address] });
    if (!delegate) return { balance: await readBalance };
    const [balance, authorized, allowance] = await Promise.all([
      readBalance,
      this.#publicClient.readContract({ ...registry, functionName: 'isDelegateAuthorized', args: [address, delegate] }),
      this.#publicClient.readContract({ ...registry, functionName: 'delegateAllowance', args: [address, delegate] }),
    ]);
    return { balance, authorized, allowance };
  }

  /** The deposit a 402's delegate offer asks for, once it names this network's JobRegistry and the wallet `payer`. */
  #checkDelegateOffer(wallet: Address, accept: DelegateAccept): { delegate: Address; value: bigint } {
    const { chain_id, payer, delegate, instruction } = accept;
    if (chain_id !== this.network.chainId) throw new Error(`the 402 is for chain ${chain_id}, not ${this.network.chainId}.`);
    if (!sameAddress(payer, wallet)) throw new Error(`the key belongs to another wallet (${payer}), not ${wallet}.`);
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
  async #signPayment(account: LocalAccount, accept: X402Accept): Promise<string> {
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
    if (maxAmount > this.#maxPaymentWei) throw new Error(`the 402 asks for ${maxAmount} wei, more than maxPaymentWei (${this.#maxPaymentWei}).`);
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
      throw new Error(`the 402's maxTimeoutSeconds ${timeout} is not between 1 and ${MAX_TIMEOUT_SECONDS}.`);
    }
    // The cap is the amount asked, not maxPaymentWei: the server debits the fee, at most the cap.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + timeout);
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const message = { payer: account.address, payTo, facilitator, maxAmount, deadline, nonce };
    const signature = await account.signTypedData({
      domain: { ...DEBIT_DOMAIN, chainId: this.network.chainId, verifyingContract: this.network.jobRegistry },
      types: DEBIT_AUTHORIZATION,
      primaryType: 'DebitAuthorization',
      message,
    });
    const authorization = { ...message, maxAmount: maxAmount.toString(), deadline: deadline.toString() };
    // `accepted` is the requirements verbatim: the server compares them field by field.
    return toBase64(JSON.stringify({ x402Version: 2, accepted: accept, payload: { signature, authorization } }));
  }
}

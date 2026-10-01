# @lightchain/sdk

Keys and money for the LightChain AI Developer API. Completions need no SDK of ours: the Developer API is OpenAI-compatible, so any OpenAI SDK works once you change its base URL.

## Completions: the OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://chat-api.testnet.lightchain.ai/v1",
  apiKey: process.env.LIGHTCHAIN_API_KEY, // lcai_...
});

const completion = await client.chat.completions.create({
  model: "gemma4:e2b", // GET /v1/models lists the ones served now
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(completion.choices[0].message.content);
```

Each completion is one job on chain, paid from the prepaid LCAI balance of the wallet that minted the key. Its `lightchain` field (type `LightchainJob`) names the job: `job_id`, `session_id`, `tx_hash`, `worker`.

## Keys and money: this SDK

```sh
npm install @lightchain/sdk openai
```

The SDK holds a wallet key. It mints API keys with a wallet signature, deposits and authorizes the API to spend, reads the balance, and pays a `402` by itself: through the API's delegate (the default), or per request with x402 ([x402 mode](#x402-mode-pay-per-request)).

```ts
import OpenAI from "openai";
import { privateKeyToAccount } from "viem/accounts";
import { Lightchain } from "@lightchain/sdk";

const lc = new Lightchain({
  network: "testnet",
  account: privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`),
  depositWei: 10n ** 18n, // what one deposit sends: 1 LCAI
});

// 1. Mint an API key: a Sign-In with Ethereum signature, no gas.
const { key } = await lc.createApiKey({ name: "backend-prod" });

// 2. Complete through the OpenAI SDK, with the SDK's fetch: on the first 402 it
//    sends the depositAndAuthorize transaction from the wallet and retries.
const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: key, fetch: lc.fetch });
const completion = await openai.chat.completions.create({
  model: "gemma4:e2b",
  messages: [{ role: "user", content: "Say hello in five words." }],
});

// 3. Read the prepaid balance on chain.
console.log(await lc.getBalance()); // { balance: 999...n }
```

| Member | Does |
| --- | --- |
| `new Lightchain({ network, account, payment?, depositWei?, onDeposit?, maxPaymentWei?, onPayment?, keyless?, agentOf?, fetch?, transport? })` | `network` is `"mainnet"`, `"testnet"`, or your own `Network` (a devnet). `account` is a viem local account. `payment` is `"delegate"` (the default: `depositWei`, `onDeposit`) or `"x402"` (`maxPaymentWei`, required, `onPayment` and `keyless`). `agentOf` makes `account` an agent key of that smart account ([agents](#owner-and-agent-keys)). |
| `createApiKey(input?)` | Signs in and mints a key bound to the wallet. `input`: `name`, `scope` (`chat` or `read`), `spendCapWei`, `requestsPerMinute`, `concurrentSessions`, `dailySpendCapWei`. The answer's `key` is shown this once. |
| `signIn()` | The Sign-In with Ethereum token (one hour), for the other key routes (`GET`/`PATCH`/`DELETE /api/api-keys`). |
| `fetch` | `fetch` that pays a `402` the way `payment` says and sends the request again, once. Give it to the OpenAI SDK. |
| `depositAndAuthorize(delegate, value)` | Sends the transaction yourself: adds `value` to the balance, authorizes `delegate` (the API's signer) and raises its allowance by `value`. Resolves with the transaction hash once it succeeded. |
| `deposit(value)` | Adds `value` to the prepaid balance and authorizes nobody: what x402 pays from. Resolves with the transaction hash once it succeeded. |
| `getBalance(delegate?)` | The prepaid balance; with `delegate`, also whether it is authorized and its remaining allowance. |
| `setupAccount({ apiKey, depositWei })` | Makes the wallet a smart account through the API's sponsor, which pays the gas, depositing `depositWei` and authorizing the API's delegate. Once per account. |
| `installAgentKey(key, { targets, spendCapWei, expiry, gasWei? })` / `revokeAgentKey(key)` | The smart account's owner installs or revokes an agent key, in its own transaction. |
| `baseURL`, `address`, `network` | The OpenAI base URL, the wallet, the endpoints in use. |

### Paying a 402 through the delegate

This is the default mode, `payment: "delegate"`. While the wallet has not paid, a completion answers `402` with the transaction to send in `error.accepts` (codes `delegate_not_authorized`, `insufficient_balance`, `allowance_exhausted`). `lc.fetch` sends that `depositAndAuthorize` with `depositWei`, or with the 402's minimum (one job's fee) when `depositWei` is not set, then sends the request again. `onDeposit` is told of every deposit it makes.

Before sending anything it checks the 402 against the network it was given: the chain id, the wallet (the key must be this wallet's), and the contract (this network's JobRegistry). A 402 that fails a check, or asks for more than `depositWei`, is not paid: it comes back as a 402 with the reason at the start of `error.message`. A 402 for a limit you set (`spend_cap_exceeded`, `daily_spend_cap_exceeded`) comes back as it is. This mode never signs an x402 payment: it leaves the `prepaid-debit` entry in `accepts` alone.

The delegate and the fee come from the API: the SDK trusts the API it talks to for those, as it trusts it with your key. Set `depositWei` to bound what one 402 can make it send.

Each 402 pays its own deposit, one transaction after the other. Calls made together before the first deposit lands each deposit `depositWei`; what one of them did not need stays in the prepaid balance, and `withdrawBalance` on the JobRegistry takes it back.

### x402 mode: pay per request

With `payment: "x402"`, the SDK pays each call from the account's own prepaid balance with a signed debit authorization ([x402](https://x402.org), LightChain's `prepaid-debit` scheme). The account authorizes no delegate and sends no transaction per call; it deposits once.

```ts
import OpenAI from "openai";
import { privateKeyToAccount } from "viem/accounts";
import { Lightchain, type LightchainJob } from "@lightchain/sdk";

const lc = new Lightchain({
  network: "testnet",
  account: privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`),
  payment: "x402",
  maxPaymentWei: 10n ** 16n, // required: the most one call may pay (0.01 LCAI)
  onPayment: (p) => console.log(`settled in ${p.hash}, ${p.amount} wei debited`),
});

// Once: fund the prepaid balance. deposit() authorizes nobody.
await lc.deposit(10n ** 18n);

const { key } = await lc.createApiKey({ name: "agent" });
const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: key, fetch: lc.fetch });
const completion = await openai.chat.completions.create({
  model: "gemma4:e2b",
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log((completion as unknown as { lightchain: LightchainJob }).lightchain.tx_hash); // the settlement
```

On a `402` whose `accepts` lists the `prepaid-debit` requirements, `lc.fetch` signs an EIP-712 debit authorization with the account: capped at the requirements' `amount` (one job's fee), valid until now + `maxTimeoutSeconds`, with a random 32-byte nonce. It sends the request again with the authorization in the `PAYMENT-SIGNATURE` header. The API settles it before it answers: one JobRegistry transaction submits the job and debits the fee from the account's balance. The completion's `lightchain.tx_hash` is that settlement transaction, and `onPayment` gets it with the fee debited, from the `PAYMENT-RESPONSE` header.

Before signing, the SDK checks the requirements against the network it was given: `network` is `eip155:<chainId>`, `asset` is the network's JobRegistry, the signing domain is `LightChain JobRegistry` version `1`, `payTo` and `facilitatorAddress` are addresses, `maxTimeoutSeconds` is between 1 and 600, and `amount` is at most `maxPaymentWei`. Requirements that fail a check are not signed: the 402 comes back with the reason at the start of `error.message`. So does a 402 that offers only the delegate way (an API that takes no x402 payments).

- **The modes do not mix.** x402 mode never sends `depositAndAuthorize`, and delegate mode never signs an x402 payment.
- **A wallet with a delegate gets no 402 on its key.** Its calls are served through the delegate, in either mode; x402 mode pays only the calls the API asks it to pay. A `keyless` call names no wallet, so it is always asked to pay.
- **The API key goes with every call, unless `keyless`.** It authenticates the call and holds it to the key's limits. The payer is the account, usually the wallet that minted the key.
- **A refused payment comes back as the API answered it** (for example `402` `insufficient_funds`, or `invalid_prepaid_debit_payload_expired`), with the x402 reason as `error.code`. The SDK does not pay it again. The Developer API's Payment page lists the codes and what to do about each.

#### With no API key

Add `keyless: true` and skip the key: no sign-in, nothing minted. `lc.fetch` then drops the `Authorization` header, so the OpenAI SDK's `apiKey` can be any string (it insists on one). The API answers the call `402` with the x402 requirements alone, the SDK pays it, and the account is held, as payer, to the API's per-payer limits instead of a key's: by default 30 requests a minute, one call in flight, and 1 LCAI a day.

```ts
const lc = new Lightchain({ network: "testnet", account, payment: "x402", maxPaymentWei: 10n ** 16n, keyless: true });
await lc.deposit(10n ** 18n); // once
const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: "x402", fetch: lc.fetch });
```

## Agents

Two ways to give a bot money to spend. Start with the first; move to the second when one wallet per bot stops being enough.

### One bot, one wallet

Make a key for the bot alone and fund it with only its budget. The bot gets that key and an API key: no smart account, no agent key. The wallet's balance is the cap.

```ts
const bot = new Lightchain({ network: "testnet", account: privateKeyToAccount(process.env.BOT_KEY as `0x${string}`) });
const { key } = await bot.createApiKey({ name: "bot" });
const openai = new OpenAI({ baseURL: bot.baseURL, apiKey: key, fetch: bot.fetch });
```

### Owner and agent keys

For teams and fleets: worth it when several bots share one account, each with its own budget, or when the account holds more than one bot should spend. A leaked bot key is then revoked and replaced without moving funds or changing the address, and the owner key can stay offline.

A key held by code becomes a smart account: the same address, now running LightChain's account code ([EIP-7702](https://eips.ethereum.org/EIPS/eip-7702)). Its owner then installs agent keys: signing keys the account holds to a list of contracts, a total spend cap and an expiry, so the bot never holds the owner key.

```ts
import OpenAI from "openai";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Lightchain } from "@lightchain/sdk";

// The owner: a fresh key holding some LCAI. The sponsor pays the setup's gas.
const owner = new Lightchain({ network: "testnet", account: privateKeyToAccount(process.env.OWNER_KEY as `0x${string}`) });
const { key } = await owner.createApiKey({ name: "agent" });
await owner.setupAccount({ apiKey: key, depositWei: 10n ** 18n });

const agentKey = privateKeyToAccount(generatePrivateKey());
const limits = { targets: [owner.network.jobRegistry], spendCapWei: 5n * 10n ** 18n, expiry: new Date(Date.now() + 7 * 86_400_000) };
await owner.installAgentKey(agentKey.address, { ...limits, gasWei: 10n ** 16n });

// The agent holds the agent key and the API key, never the owner key. Its fetch pays 402s from the account.
const agent = new Lightchain({ network: "testnet", account: agentKey, agentOf: owner.address });
const openai = new OpenAI({ baseURL: agent.baseURL, apiKey: key, fetch: agent.fetch });
await openai.chat.completions.create({ model: "gemma4:e2b", messages: [{ role: "user", content: "Hello" }] });
```

- **`setupAccount`** signs the EIP-7702 authorization for the network's account code and a batch of one `depositAndAuthorize` of the API's delegate, and `POST /v1/account/setup` has the sponsor send both as one transaction and pay its gas. The deposit is the account's own LCAI. It resolves once the account runs the code, waiting for the transaction itself when the sponsor answered before it was mined; a refusal (`already_sponsored`, `simulation_reverted`, `fee_cap_exceeded`, ...) throws a `LightchainError` with that `code`. The sponsor pays for one setup per account. The endpoint authenticates by API key, hence `createApiKey` first, while the address is still a plain key.
- **No session request in the setup.** The sponsor would pay for one, but the Developer API opens its own sessions through the delegate and never adopts a session the account requested, which a worker would claim and leave to expire.
- **The owner's own transactions** install and revoke agent keys, and the account pays their gas: keep some LCAI in it after the deposit. `installAgentKey` replaces the limits a key already had.
- **A client with `agentOf`** pays for the smart account: `address` and `getBalance()` are the account's, and its `deposit` and `depositAndAuthorize` are batches the agent key signs for the account. So once the setup's deposit is spent, its `fetch` pays each `402` with such a batch. The agent key submits each batch itself and pays its gas from its own LCAI (`gasWei`). The account refuses a batch that calls a contract outside `targets` (whole contracts), sends more of its LCAI than is left of `spendCapWei`, or comes after `expiry`; viem names the error (`AgentKeySpendCapExceeded`, ...). The cap counts only LCAI the batches send: a key allowed on JobRegistry can call any JobRegistry function as the account, authorizing a delegate or submitting jobs from its prepaid balance included.
- **The API key is the owner's.** The Developer API authenticates a completion by its API key and bills the address that minted it, here the smart account. An agent key cannot sign in for the account, so it cannot mint keys, and it cannot sign x402 payments (JobRegistry takes only the payer's own signature): its client refuses both. Hand the agent the API key with the agent key.

`setupAccount` needs the network's `accountImplementation`: `mainnet` and `testnet` name none until the account code and the sponsor are deployed there, so pass your own `Network` meanwhile.

## Networks

`networks` holds the published endpoints and addresses; `jobRegistryAbi` holds the JobRegistry functions the SDK calls, cut from the compiled contracts, and `lightChainAccountAbi` the smart account's (`agentKey(key)` reads a key's limits).

| | Chain | API (`apiUrl`) | RPC | JobRegistry |
| --- | --- | --- | --- | --- |
| `mainnet` | 9200 | `https://chat-api.mainnet.lightchain.ai` (provisional) | `https://rpc.mainnet.lightchain.ai` | `0xfB15F90298e4CcD7106E76fFB5e520315cC42B0b` |
| `testnet` | 8200 | `https://chat-api.testnet.lightchain.ai` | `https://rpc.testnet.lightchain.ai` | `0x531b3A87c5D785441B9cF55b98169F20FD9056a7` |

The mainnet Developer API hostname is not decided yet. `chat-api.mainnet.lightchain.ai` is the production consumer API's name, but today it serves an older consumer API without the key routes and `/v1`: mainnet calls fail there until the Developer API is deployed behind it.

## Development

```sh
npm install
npm test            # unit tests against recorded devnet answers (Node >= 22.18)
npm run typecheck
npm run build       # dist/
npm run abi         # regenerate src/abi.ts from ../pkg/chain/abis (after `make bindings`)
WALLET_PRIVATE_KEY=0x... npm run acceptance   # end to end on testnet; see scripts/acceptance.ts
WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_MODEL=gemma4:e2b npm run acceptance:x402   # keyless x402 mode; see scripts/acceptance-x402.ts
WALLET_PRIVATE_KEY=0x... npm run acceptance:account   # a fresh key: setup, agent key, completion; see scripts/acceptance-account.ts
```

The fixtures in `test/fixtures` were recorded from a local devnet (`make devnet-full`, chain 48221) with Foundry's publicly known test account 7. The x402 tests sign the scheme's published test vectors (`../scripts/x402-vectors/vectors.json`) byte for byte, with Foundry's test account 3. Never use either key on a real network.

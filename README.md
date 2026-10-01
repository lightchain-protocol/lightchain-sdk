# @lightchain/sdk

The LightChain AI Developer API for TypeScript: it runs an API key against the right network, and, given a wallet, pays a `402` by itself. Completions go through the OpenAI SDK: the Developer API is OpenAI-compatible.

```sh
npm install @lightchain/sdk openai
```

## 1. Create a key in the chat: Developer → API keys

The chat's Developer page (`/developer`) creates your API keys and lists them. A key carries a name, a scope (`chat` or `read`), rate limits and an optional lifetime spend cap. The key itself (`lcai_...`) is shown once: store it like a password. Every key you create spends from your one prepaid balance, which you top up in the chat.

## 2. One bot, one API key

```ts
import OpenAI from "openai";
import { Lightchain } from "@lightchain/sdk";

const lc = new Lightchain({ network: "testnet", apiKey: process.env.LIGHTCHAIN_API_KEY! });
const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: lc.apiKey, fetch: lc.fetch });

const completion = await openai.chat.completions.create({
  model: "gemma4:e2b", // GET /v1/models lists the ones served now
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(completion.choices[0].message.content);
```

This is the default pattern. The bot holds the key and nothing else: no wallet, no funds. The key's lifetime spend cap is the bot's budget. The funds stay in your prepaid balance, and you top it up in the chat. A leaked key is revoked in the chat and replaced, with no funds to move.

Each completion is one job on chain, paid from the prepaid balance of the wallet that created the key. Its `lightchain` field (type `LightchainJob`) names the job: `job_id`, `session_id`, `tx_hash`, `worker`. `dropped_messages`, when present, says how many of the conversation's oldest messages the job left out to fit what one job carries.

Until the wallet behind the key has paid, and whenever its balance or allowance runs out, a call answers `402` (codes `delegate_not_authorized`, `insufficient_balance`, `allowance_exhausted`). `lc.fetch` hands it back as the API answered it, and the OpenAI SDK raises it as an `APIError`: a human tops up in the chat. Past the key's cap, the call answers `402` `spend_cap_exceeded`.

## Automatic top-ups

To run a bot unattended, give it the wallet behind the key as `account` (a viem local account). On a `402` for an empty balance or allowance, `lc.fetch` then sends the `depositAndAuthorize` the 402 names from that wallet, and sends the request again.

```ts
import { privateKeyToAccount } from "viem/accounts";

const lc = new Lightchain({
  network: "testnet",
  apiKey: process.env.LIGHTCHAIN_API_KEY!,
  account: privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`),
  depositWei: 10n ** 18n, // what one deposit sends: 1 LCAI
  onDeposit: (d) => console.log(`deposited ${d.value} wei in ${d.hash}`),
});
```

The deposit is `depositWei`, or the 402's minimum (one job's fee) when `depositWei` is not set. Before sending anything, the SDK checks the 402 against the network it was given: the chain id, the wallet (the key must be this wallet's), and the contract (this network's JobRegistry). A 402 that fails a check, or asks for more than `depositWei`, is not paid: it comes back as a 402 with the reason at the start of `error.message`. A `spend_cap_exceeded` 402 comes back as it is.

The delegate and the fee come from the API: the SDK trusts the API it talks to for those, as it trusts it with your key. Set `depositWei` to bound what one 402 can make it send.

Each 402 pays its own deposit, one transaction after the other. Calls made together before the first deposit lands each deposit `depositWei`; what one of them did not need stays in the prepaid balance, and `withdrawBalance` on the JobRegistry takes it back.

## x402: pay per request

With `payment: "x402"`, the SDK pays each call from the account's own prepaid balance with a signed debit authorization ([x402](https://x402.org), LightChain's `prepaid-debit` scheme). The account authorizes no delegate and sends no transaction per call; it deposits once. It needs `account`, and either an API key or `keyless: true`.

```ts
import OpenAI from "openai";
import { privateKeyToAccount } from "viem/accounts";
import { Lightchain, type LightchainJob } from "@lightchain/sdk";

const lc = new Lightchain({
  network: "testnet",
  account: privateKeyToAccount(process.env.WALLET_PRIVATE_KEY as `0x${string}`),
  payment: "x402",
  maxPaymentWei: 10n ** 16n, // required: the most one call may pay (0.01 LCAI)
  keyless: true, // or apiKey: process.env.LIGHTCHAIN_API_KEY
  onPayment: (p) => console.log(`settled in ${p.hash}, ${p.amount} wei debited`),
});

await lc.deposit(10n ** 18n); // once: fund the prepaid balance; it authorizes nobody

const openai = new OpenAI({ baseURL: lc.baseURL, apiKey: lc.apiKey, fetch: lc.fetch });
const completion = await openai.chat.completions.create({
  model: "gemma4:e2b",
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log((completion as unknown as { lightchain: LightchainJob }).lightchain.tx_hash); // the settlement
```

On a `402` whose `accepts` lists the `prepaid-debit` requirements, `lc.fetch` signs an EIP-712 debit authorization with the account: capped at the requirements' `amount` (one job's fee), valid until now + `maxTimeoutSeconds`, with a random 32-byte nonce. It sends the request again with the authorization in the `PAYMENT-SIGNATURE` header. The API settles it before it answers: one JobRegistry transaction submits the job and debits the fee from the account's balance. The completion's `lightchain.tx_hash` is that settlement transaction, and `onPayment` gets it with the fee debited, from the `PAYMENT-RESPONSE` header.

Before signing, the SDK checks the requirements against the network it was given: `network` is `eip155:<chainId>`, `asset` is the network's JobRegistry, the signing domain is `LightChain JobRegistry` version `1`, `payTo` and `facilitatorAddress` are addresses, `maxTimeoutSeconds` is between 1 and 600, and `amount` is at most `maxPaymentWei`. Requirements that fail a check are not signed: the 402 comes back with the reason at the start of `error.message`. So does a 402 that offers only the delegate way (an API that takes no x402 payments).

- **Keyless, no key at all.** `lc.fetch` drops the `Authorization` header, and `lc.apiKey` is a placeholder for the OpenAI SDK, which insists on one. The API answers every call `402` with the x402 requirements alone, the SDK pays it, and the account is held, as payer, to the API's per-payer limits instead of a key's: by default 30 requests a minute, one call in flight, and 1 LCAI a day.
- **With a key,** `lc.fetch` sends it on every call: it authenticates the call and holds it to the key's limits. A key whose wallet has a delegate gets no 402, so x402 pays only the calls the API asks it to pay.
- **The modes do not mix.** x402 mode never sends `depositAndAuthorize`, and the default mode never signs an x402 payment.
- **A refused payment comes back as the API answered it** (for example `402` `insufficient_funds`, or `invalid_prepaid_debit_payload_expired`), with the x402 reason as `error.code`. The SDK does not pay it again. The Developer API's Payment page lists the codes and what to do about each.

## Members

| Mode | `apiKey` | `account` |
| --- | --- | --- |
| default (`payment: "delegate"`) | required | optional: with it, `fetch` pays a 402 (`depositWei`, `onDeposit`) |
| `payment: "x402"` | required, unless `keyless: true` | required: it signs each payment (`maxPaymentWei`, required, `onPayment`) |

The constructor throws on any other combination, and on an option the mode would ignore.

| Member | Does |
| --- | --- |
| `new Lightchain({ network, apiKey, account?, payment?, ..., fetch?, transport? })` | `network` is `"mainnet"`, `"testnet"`, or your own `Network` (a devnet). The other options are in the table above. |
| `fetch` | `fetch` that sends `Authorization: Bearer <apiKey>` and, given an `account`, pays a `402` the way `payment` says and sends the request again, once. Give it to the OpenAI SDK. |
| `baseURL`, `apiKey` | The OpenAI SDK's `baseURL` (the network's `/v1`) and `apiKey`. |
| `getBalance(delegate?)` | The account's prepaid balance; with `delegate`, also whether it is authorized and its remaining allowance. Needs `account`. |
| `deposit(value)` | Adds `value` to the account's prepaid balance and authorizes nobody: what x402 pays from. Needs `account`. |
| `depositAndAuthorize(delegate, value)` | Adds `value` to the balance, authorizes `delegate` (the API's signer) and raises its allowance by `value`. Needs `account`. |
| `address`, `network` | The account's address, if any, and the endpoints in use. |

`deposit` and `depositAndAuthorize` resolve with the transaction hash once it succeeded on chain.

## Networks

`networks` holds the published endpoints and addresses; `jobRegistryAbi` holds the JobRegistry functions the SDK calls, cut from the compiled contracts.

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
WALLET_PRIVATE_KEY=0x... npm run acceptance   # a fresh wallet: the key alone gets its 402, then account pays it; see scripts/acceptance.ts
WALLET_PRIVATE_KEY=0x... LIGHTCHAIN_MODEL=gemma4:e2b npm run acceptance:x402   # keyless x402 mode; see scripts/acceptance-x402.ts
```

The fixtures in `test/fixtures` were recorded from a local devnet (`make devnet-full`, chain 48221) with Foundry's publicly known test account 7. The x402 tests sign the scheme's published test vectors (`../scripts/x402-vectors/vectors.json`) byte for byte, with Foundry's test account 3. Never use either key on a real network.

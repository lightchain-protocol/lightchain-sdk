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
  model: "llama3-8b", // GET /v1/models lists the ones served now
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(completion.choices[0].message.content);
```

Each completion is one job on chain, paid from the prepaid LCAI balance of the wallet that minted the key. Its `lightchain` field (type `LightchainJob`) names the job: `job_id`, `session_id`, `tx_hash`, `worker`.

## Keys and money: this SDK

```sh
npm install @lightchain/sdk openai
```

The SDK holds a wallet key. It mints API keys with a wallet signature, deposits and authorizes the API to spend, reads the balance, and pays a `402` by itself.

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
  model: "llama3-8b",
  messages: [{ role: "user", content: "Say hello in five words." }],
});

// 3. Read the prepaid balance on chain.
console.log(await lc.getBalance()); // { balance: 999...n }
```

| Member | Does |
| --- | --- |
| `new Lightchain({ network, account, depositWei?, onDeposit?, fetch?, transport? })` | `network` is `"mainnet"`, `"testnet"`, or your own `Network` (a devnet). `account` is a viem local account. |
| `createApiKey(input?)` | Signs in and mints a key bound to the wallet. `input`: `name`, `scope` (`chat` or `read`), `spendCapWei`, `requestsPerMinute`, `concurrentSessions`, `dailySpendCapWei`. The answer's `key` is shown this once. |
| `signIn()` | The Sign-In with Ethereum token (one hour), for the other key routes (`GET`/`PATCH`/`DELETE /api/api-keys`). |
| `fetch` | `fetch` that pays a `402` and sends the request again, once. Give it to the OpenAI SDK. |
| `depositAndAuthorize(delegate, value)` | Sends the transaction yourself: adds `value` to the balance, authorizes `delegate` (the API's signer) and raises its allowance by `value`. Resolves with the transaction hash once it succeeded. |
| `getBalance(delegate?)` | The prepaid balance; with `delegate`, also whether it is authorized and its remaining allowance. |
| `baseURL`, `address`, `network` | The OpenAI base URL, the wallet, the endpoints in use. |

### Paying a 402

While the wallet has not paid, a completion answers `402` with the transaction to send in `error.accepts` (codes `delegate_not_authorized`, `insufficient_balance`, `allowance_exhausted`). `lc.fetch` sends that `depositAndAuthorize` with `depositWei`, or with the 402's minimum (one job's fee) when `depositWei` is not set, then sends the request again. `onDeposit` is told of every deposit it makes.

Before sending anything it checks the 402 against the network it was given: the chain id, the wallet (the key must be this wallet's), and the contract (this network's JobRegistry). A 402 that fails a check, or asks for more than `depositWei`, is not paid: it comes back as a 402 with the reason at the start of `error.message`. A 402 for a limit you set (`spend_cap_exceeded`, `daily_spend_cap_exceeded`) comes back as it is. 402s that arrive together while a deposit is in flight wait for it instead of paying again.

## Networks

`networks` holds the published endpoints and addresses; `jobRegistryAbi` holds the JobRegistry functions the SDK calls, cut from the compiled contracts.

| | Chain | API (`apiUrl`) | RPC | JobRegistry |
| --- | --- | --- | --- | --- |
| `mainnet` | 9200 | `https://chat-api.mainnet.lightchain.ai` (provisional) | `https://rpc.mainnet.lightchain.ai` | `0xfB15F90298e4CcD7106E76fFB5e520315cC42B0b` |
| `testnet` | 8200 | `https://chat-api.testnet.lightchain.ai` | `https://rpc.testnet.lightchain.ai` | `0x531b3A87c5D785441B9cF55b98169F20FD9056a7` |

The mainnet Developer API hostname is not decided yet; `chat-api.mainnet.lightchain.ai` is the production consumer API's name.

## Development

```sh
npm install
npm test            # unit tests against recorded devnet answers (Node >= 22.18)
npm run typecheck
npm run build       # dist/
npm run abi         # regenerate src/abi.ts from ../pkg/chain/abis (after `make bindings`)
WALLET_PRIVATE_KEY=0x... npm run acceptance   # end to end on testnet; see scripts/acceptance.ts
```

The fixtures in `test/fixtures` were recorded from a local devnet (`make devnet-full`, chain 48221) with Foundry's publicly known test account 7. Never use that key on a real network.

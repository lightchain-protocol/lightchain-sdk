import type { Address } from 'viem';

/** Where one LightChain network's Developer API and contracts live. */
export type Network = {
  chainId: number;
  /** The Developer API's origin: key routes under /api, the OpenAI surface under /v1. */
  apiUrl: string;
  rpcUrl: string;
  /** The JobRegistry proxy: prepaid balances and delegate authorizations live there. */
  jobRegistry: Address;
  /** The LightChainAccount code a smart account adopts: the only code the sponsor pays a setup for. */
  accountImplementation?: Address;
};

export const networks = {
  // JobRegistry from scripts/mainnet/chat/manifest.mainnet.json (verified live 2026-09-09).
  // ponytail: the mainnet Developer API hostname is not decided; this is the
  // production consumer-api name, which serves an older API without the key
  // routes and /v1 today. Change it here once one is chosen.
  mainnet: {
    chainId: 9200,
    apiUrl: 'https://chat-api.mainnet.lightchain.ai',
    rpcUrl: 'https://rpc.mainnet.lightchain.ai',
    jobRegistry: '0xfB15F90298e4CcD7106E76fFB5e520315cC42B0b',
  },
  // JobRegistry from terraform/environments/testnet/terraform.tfvars; API from
  // consumer-api/docs/developer-api/quickstart.md.
  testnet: {
    chainId: 8200,
    apiUrl: 'https://chat-api.testnet.lightchain.ai',
    rpcUrl: 'https://rpc.testnet.lightchain.ai',
    jobRegistry: '0x531b3A87c5D785441B9cF55b98169F20FD9056a7',
  },
} as const satisfies Record<string, Network>;

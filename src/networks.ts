import type { Address } from 'viem';

/** Where one LightChain network's Developer API and contracts live. */
export type Network = {
  chainId: number;
  /** The Developer API's origin: key routes under /api, the OpenAI surface under /v1. */
  apiUrl: string;
  rpcUrl: string;
  /** The JobRegistry proxy: prepaid balances and delegate authorizations live there. */
  jobRegistry: Address;
};

export const networks = {
  // The mainnet Developer API is not live yet, and its URL may change.
  mainnet: {
    chainId: 9200,
    apiUrl: 'https://chat-api.mainnet.lightchain.ai',
    rpcUrl: 'https://rpc.mainnet.lightchain.ai',
    jobRegistry: '0xfB15F90298e4CcD7106E76fFB5e520315cC42B0b',
  },
  testnet: {
    chainId: 8200,
    apiUrl: 'https://chat-api.testnet.lightchain.ai',
    rpcUrl: 'https://rpc.testnet.lightchain.ai',
    jobRegistry: '0x531b3A87c5D785441B9cF55b98169F20FD9056a7',
  },
} as const satisfies Record<string, Network>;

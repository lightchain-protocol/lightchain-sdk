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
    jobRegistry: '0xD09482621a7D7df81E69fDB8F14961c0BfbaF63D',
  },
} as const satisfies Record<string, Network>;

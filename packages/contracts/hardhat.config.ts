import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';

const BASE_RPC_URL = process.env.BASE_RPC_URL || '';
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || '';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    base: {
      url: BASE_RPC_URL,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
      chainId: 8453
    }
  }
};

export default config;

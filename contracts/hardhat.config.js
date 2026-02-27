require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    hardhat: {},
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    monadMainnet: {
      url: process.env.MONAD_RPC_URL || "https://rpc.monad.xyz",
      chainId: 143,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },

    // ✅ Add these:
    bnbTestnet: {
      url: process.env.BNB_TESTNET_RPC_URL || "https://bsc-testnet.publicnode.com",
      chainId: 97,
      accounts: process.env.BNB_DEPLOYER_PRIVATE_KEY ? [process.env.BNB_DEPLOYER_PRIVATE_KEY] : [],
    },
    bnbMainnet: {
      url: process.env.BNB_RPC_URL || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: process.env.BNB_DEPLOYER_PRIVATE_KEY ? [process.env.BNB_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
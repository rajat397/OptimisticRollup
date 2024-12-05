require("@nomicfoundation/hardhat-toolbox");
require('dotenv').config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.17",
  solidity: {
    compilers: [
      {
        version: "0.8.17",
        settings: {      
          optimizer: {
            enabled: true,
            runs: 1000,
          }
        },
      },
    ]
  },
  defaultNetwork: "localhost",
  networks: {
    goerli: {
      url: process.env.AU_TESTNET_HTTP_URL,
      accounts : [process.env.TESTNET_SEQUENCER_PRIVATE_KEY],
    },
    localhost: {
      url : process.env.LOCALHOST_HTTP_URL,
      accounts : [process.env.TESTNET_SEQUENCER_PRIVATE_KEY],
      // gas: 10100000,
      // gasPrice: 130000000000
    }
  }
};

// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
const hre = require("hardhat");

async function main() {
  // disable auto mining.
  await network.provider.send("evm_setAutomine", [false]);
  // set average block time to 10s
  await network.provider.send("evm_setIntervalMining", [12000]);
  const OPR_Contract = await hre.ethers.getContractFactory("OPR_Contract");
  const opr_contract = await OPR_Contract.deploy();

  await opr_contract.deployed();

  console.log(
    `opr_contract deployed to ${opr_contract.address}`
  );
  
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

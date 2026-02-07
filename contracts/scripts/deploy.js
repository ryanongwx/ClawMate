const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "MON");

  const ChessBetEscrow = await hre.ethers.getContractFactory("ChessBetEscrow");
  const contract = await ChessBetEscrow.deploy();
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log("ChessBetEscrow deployed to:", addr);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

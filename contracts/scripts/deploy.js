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

  // Optional: set resolver so the backend (RESOLVER_PRIVATE_KEY) can call resolveGame without being owner.
  const resolverAddress = process.env.RESOLVER_ADDRESS;
  if (resolverAddress && resolverAddress.startsWith("0x")) {
    try {
      const tx = await contract.setResolver(resolverAddress);
      await tx.wait();
      console.log("Resolver set to:", resolverAddress);
    } catch (e) {
      console.warn("setResolver failed:", e.message);
    }
  } else {
    console.log("RESOLVER_ADDRESS not set — only owner can resolve. Set resolver with: contract.setResolver(<backend_resolver_address>)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

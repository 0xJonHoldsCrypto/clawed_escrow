import hardhat from 'hardhat';
const { ethers } = hardhat;

// Base USDC (native) address on Base mainnet.
// You can override via env USDC_ADDRESS.
const DEFAULT_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function main() {
  const usdc = process.env.USDC_ADDRESS || DEFAULT_USDC;

  // Hard defaults (per Jon): use Clawed profit wallet for admin/treasury/arbiter unless overridden.
  const DEFAULT_TREASURY = '0x5efe6aEeb9eD1e9E562755DA9D9210FD1844f18e';
  const treasury = process.env.TREASURY_ADDRESS || DEFAULT_TREASURY;
  const arbiter = process.env.ARBITER_ADDRESS || DEFAULT_TREASURY;

  // Fees are fixed in-contract (CREATOR_FEE_BPS=200, RECIPIENT_FEE_BPS=200).

  const [deployer] = await ethers.getSigners();
  console.log('deployer:', deployer.address);

  const Factory = await ethers.getContractFactory('ClawedEscrow');
  const c = await Factory.deploy(usdc, treasury, arbiter);
  await c.waitForDeployment();

  console.log('ClawedEscrow deployed:', await c.getAddress());
  console.log({ usdc, treasury, arbiter, CREATOR_FEE_BPS: 200, RECIPIENT_FEE_BPS: 200 });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

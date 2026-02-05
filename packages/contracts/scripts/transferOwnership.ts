import hardhat from 'hardhat';
const { ethers } = hardhat;

async function main() {
  const addr = process.env.CONTRACT_ADDRESS;
  const newOwner = process.env.NEW_OWNER;
  if (!addr) throw new Error('CONTRACT_ADDRESS required');
  if (!newOwner) throw new Error('NEW_OWNER required');

  const [deployer] = await ethers.getSigners();
  console.log('deployer:', deployer.address);
  console.log('contract:', addr);
  console.log('newOwner:', newOwner);

  const c = await ethers.getContractAt('ClawedEscrow', addr);
  const tx = await c.transferOwnership(newOwner);
  console.log('tx:', tx.hash);
  await tx.wait();
  console.log('done. owner:', await c.owner());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

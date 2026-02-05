import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

export const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
export const ESCROW_CONTRACT_ADDRESS = (process.env.ESCROW_CONTRACT_ADDRESS || '0x879537938aaCCD249cA750F865E810414ac08D3E').toLowerCase();

// Load ABI from hardhat artifact to stay in sync with deployed contract.
// Path is relative to apps/api (process.cwd() when running from there).
const artifactPath = path.resolve(
  process.cwd(),
  '../../packages/contracts/artifacts/contracts/ClawedEscrow.sol/ClawedEscrow.json'
);
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
export const ESCROW_ABI = artifact.abi;

export const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, 8453);
export const escrow = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, provider);

export function toHex32(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value)));
}

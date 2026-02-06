import { ethers } from 'ethers';
import escrowAbiJson from './escrowAbi.json' with { type: 'json' };

export const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
export const BASE_RPC_WSS_URL = process.env.BASE_RPC_WSS_URL || null;
export const ESCROW_CONTRACT_ADDRESS = (process.env.ESCROW_CONTRACT_ADDRESS || escrowAbiJson.address || '0x879537938aaCCD249cA750F865E810414ac08D3E').toLowerCase();

// Keep a runtime ABI copy so deploy targets (Railway) don't need Hardhat artifacts.
export const ESCROW_ABI = escrowAbiJson.abi;

export const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, 8453);
export const wsProvider = BASE_RPC_WSS_URL ? new ethers.WebSocketProvider(BASE_RPC_WSS_URL, 8453) : null;

export const escrow = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, provider);
export const escrowWs = wsProvider ? new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, wsProvider) : null;

export function toHex32(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(value)));
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount, usePublicClient, useWalletClient, useSignMessage } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
// Header is rendered by the root layout
import { decodeEventLog, keccak256, parseUnits, toBytes } from 'viem';
import { ESCROW_ABI, ERC20_ABI, ESCROW_ADDRESS, USDC_ADDRESS } from '@/lib/contracts';
import { buildAuthHeaders } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

export default function NewTask() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { signMessageAsync } = useSignMessage();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!isConnected || !address || !publicClient || !walletClient) {
      setError('Please connect your wallet first');
      return;
    }

    setLoading(true);
    setError('');

    const form = e.currentTarget;
    const formData = new FormData(form);

    const title = String(formData.get('title') || '').trim();
    const instructions = String(formData.get('instructions') || '').trim();
    const amountStr = String(formData.get('amount') || '').trim();

    const maxWinners = Number(formData.get('maxWinners') || 1);
    const deadlineHours = Number(formData.get('deadlineHours') || 24);
    const reviewHours = Number(formData.get('reviewHours') || 24);
    const escalationHours = Number(formData.get('escalationHours') || 24);

    try {
      const payoutMinor = parseUnits(amountStr as `${number}`, 6);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.max(1, deadlineHours) * 3600);
      const reviewWindow = BigInt(Math.max(0, reviewHours) * 3600);
      const escalationWindow = BigInt(Math.max(0, escalationHours) * 3600);

      // Onchain metadata is hash-only for now. We hash title+instructions so it can be verified offchain.
      const specHash = keccak256(toBytes(JSON.stringify({ title, instructions })));

      // 1) createTask
      const createHash = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'createTask',
        args: [
          payoutMinor,
          BigInt(maxWinners),
          deadline,
          reviewWindow,
          escalationWindow,
          specHash,
        ],
      });

      const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

      // Extract taskId from TaskCreated event
      let taskId: bigint | null = null;
      for (const log of createReceipt.logs) {
        try {
          const decoded: any = decodeEventLog({ abi: ESCROW_ABI as any, data: log.data, topics: log.topics });
          if (decoded?.eventName === 'TaskCreated') {
            // args: (taskId, requester, payoutAmount, maxWinners, deadline, specHash)
            taskId = (decoded?.args?.taskId ?? decoded?.args?.[0] ?? null) as any;
            if (taskId !== null) break;
          }
        } catch {}
      }
      if (taskId === null) throw new Error('Could not find TaskCreated event in receipt');

      // 2) approve USDC for (payout + depositFee) * maxWinners
      const depositFeePerWinner = (payoutMinor * 200n) / 10_000n;
      const total = (payoutMinor + depositFeePerWinner) * BigInt(maxWinners);

      const approveHash = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ESCROW_ADDRESS, total],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      // 3) fundTask
      const fundHash = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'fundTask',
        args: [taskId],
      });
      await publicClient.waitForTransactionReceipt({ hash: fundHash });

      // 4) best-effort: save metadata offchain so the UI can display it (still verifiable via specHash)
      try {
        const tid = taskId.toString();
        const body = { title, instructions, specHash };
        const path = `/v2/tasks/${tid}/metadata`;
        const headers = await buildAuthHeaders({
          address,
          signMessageAsync,
          method: 'POST',
          path,
          body,
        });
        await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch {
        // ignore; onchain task still created + funded
      }

      router.push(`/tasks/${taskId.toString()}`);
    } catch (err: any) {
      setError(err?.shortMessage || err?.message || 'Failed to create+fund task');
      setLoading(false);
      return;
    }

    setLoading(false);
  }

  return (
    <div className="container container-sm">
        <div className="page-header">
          <h1>Create New Onchain Task</h1>
          <p>
            This will (1) create the task on Base and (2) approve+fund it with USDC.
            <br />
            Metadata is hash-only onchain for now.
          </p>
        </div>

        {error && (
          <div className="card card-error mb-2">
            <p className="text-error">{error}</p>
          </div>
        )}

        {!isConnected ? (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">🔗</div>
              <div className="empty-state-title">Connect Wallet</div>
              <p className="mb-2">Connect your wallet to create a task.</p>
              <ConnectButton />
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="card">
            <div className="form-group">
              <label htmlFor="title">Task Title (offchain)</label>
              <input type="text" id="title" name="title" required maxLength={200} />
            </div>

            <div className="form-group">
              <label htmlFor="instructions">Instructions (offchain)</label>
              <textarea id="instructions" name="instructions" required rows={6} />
              <p className="text-muted text-sm mt-1">
                These are hashed into <span className="font-mono">specHash</span> for now.
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="amount">Payout per winner (USDC)</label>
              <div className="input-with-addon">
                <span className="input-addon">💵</span>
                <input type="text" id="amount" name="amount" placeholder="0.10" required pattern="^\d+(\.\d{1,6})?$" />
              </div>
              <p className="text-muted text-sm mt-1">A 2% creator fee is charged at funding.</p>
            </div>

            <div className="form-group">
              <label htmlFor="maxWinners">Completions accepted (max winners)</label>
              <input type="number" id="maxWinners" name="maxWinners" min={1} defaultValue={1} required />
            </div>

            <div className="form-group">
              <label htmlFor="deadlineHours">Deadline (hours from now)</label>
              <input type="number" id="deadlineHours" name="deadlineHours" min={1} defaultValue={24} required />
            </div>

            <div className="form-group">
              <label htmlFor="reviewHours">Review window (hours)</label>
              <input type="number" id="reviewHours" name="reviewHours" min={0} defaultValue={24} required />
            </div>

            <div className="form-group">
              <label htmlFor="escalationHours">Escalation window (hours)</label>
              <input type="number" id="escalationHours" name="escalationHours" min={0} defaultValue={24} required />
            </div>

            <div className="form-group">
              <label>Your Wallet</label>
              <div className="deposit-box">
                <p className="deposit-address">{address}</p>
                <p className="text-muted text-sm">This wallet is the onchain requester.</p>
              </div>
            </div>

            <div className="flex gap-2 mt-3">
              <button type="submit" className="btn btn-primary btn-lg" disabled={loading}>
                {loading ? 'Creating & Funding…' : 'Create & Fund Onchain Task'}
              </button>
              <Link href="/" className="btn btn-secondary btn-lg">Cancel</Link>
            </div>
          </form>
        )}
    </div>
  );
}

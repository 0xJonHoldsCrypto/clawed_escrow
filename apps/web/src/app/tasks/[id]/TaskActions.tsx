'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAccount, useSignMessage } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { buildAuthHeaders } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

export default function TaskActions({ taskId, status }: { taskId: string; status: string }) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [claimId, setClaimId] = useState('');

  async function handleClaim() {
    if (!address) return;
    setLoading(true);
    setError('');

    try {
      const body = { wallet: address, agent: { type: 'wallet', id: address } };
      const headers = await buildAuthHeaders({
        address,
        signMessageAsync,
        method: 'POST',
        path: `/v1/tasks/${taskId}/claim`,
        body,
      });

      const res = await fetch(`${API_URL}/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to claim task');
      }

      const data = await res.json();
      setClaimId(data.claim.id);
      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const claimId = String(formData.get('claimId'));
      const body = { kind: 'url', payload: formData.get('proof') };
      const headers = await buildAuthHeaders({
        address: address!,
        signMessageAsync,
        method: 'POST',
        path: `/v1/claims/${claimId}/submit`,
        body,
      });

      const res = await fetch(`${API_URL}/v1/claims/${claimId}/submit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to submit proof');
      }

      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const claimId = String(formData.get('claimId'));
      const body = {};
      const headers = await buildAuthHeaders({
        address: address!,
        signMessageAsync,
        method: 'POST',
        path: `/v1/claims/${claimId}/approve`,
        body,
      });

      const res = await fetch(`${API_URL}/v1/claims/${claimId}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve');
      }

      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleReject(claimIdToReject: string) {
    setLoading(true);
    setError('');

    try {
      const body = {};
      const headers = await buildAuthHeaders({
        address: address!,
        signMessageAsync,
        method: 'POST',
        path: `/v1/claims/${claimIdToReject}/reject`,
        body,
      });

      const res = await fetch(`${API_URL}/v1/claims/${claimIdToReject}/reject`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reject');
      }

      router.refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (status === 'draft') {
    return (
      <div className="card mt-2">
        <h2>⏳ Awaiting Funding</h2>
        <p className="text-secondary">
          This task needs to be funded before it can be claimed. Send USDC to the deposit address above.
        </p>
      </div>
    );
  }

  return (
    <div className="card mt-2">
      <h2>Actions</h2>

      {error && (
        <div className="card card-error mb-2">
          <p className="text-error">{error}</p>
        </div>
      )}

      {status === 'open' && (
        <>
          {!isConnected ? (
            <div className="text-center">
              <p className="text-secondary mb-2">Connect your wallet to claim this task.</p>
              <ConnectButton />
            </div>
          ) : (
            <div>
              <p className="text-secondary mb-2">
                Claim this task to start working on it. You'll need to submit proof when complete.
              </p>
              <button onClick={handleClaim} className="btn btn-primary" disabled={loading}>
                {loading ? 'Claiming...' : '🎯 Claim Task'}
              </button>
              <p className="text-muted text-sm mt-2">
                Your wallet: {address?.slice(0, 6)}...{address?.slice(-4)}
              </p>
            </div>
          )}
        </>
      )}

      {status === 'claimed' && (
        <form onSubmit={handleSubmit}>
          <p className="text-secondary mb-2">Submit proof that you completed the task.</p>
          <div className="form-group">
            <label htmlFor="claimId">Claim ID</label>
            <input
              type="text"
              id="claimId"
              name="claimId"
              placeholder="Paste your claim ID"
              required
              defaultValue={claimId}
            />
          </div>
          <div className="form-group">
            <label htmlFor="proof">Proof URL or Description</label>
            <textarea
              id="proof"
              name="proof"
              placeholder="Link to your completed work, screenshot URL, or description..."
              required
              rows={3}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Submitting...' : '📤 Submit Proof'}
          </button>
        </form>
      )}

      {status === 'submitted' && (
        <form onSubmit={handleApprove}>
          <p className="text-secondary mb-2">
            Review the submission and approve or reject. Only the task requester can do this.
          </p>
          <div className="form-group">
            <label htmlFor="claimId">Claim ID</label>
            <input
              type="text"
              id="claimId"
              name="claimId"
              placeholder="Paste the claim ID to review"
              required
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-success" disabled={loading}>
              {loading ? 'Processing...' : '✓ Approve & Pay'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={loading}
              onClick={(e) => {
                const form = e.currentTarget.closest('form');
                const claimIdInput = form?.querySelector('input[name="claimId"]') as HTMLInputElement;
                if (claimIdInput?.value) handleReject(claimIdInput.value);
              }}
            >
              ✗ Reject
            </button>
          </div>
        </form>
      )}

      {status === 'approved' && (
        <div className="text-center">
          <div className="empty-state-icon">✅</div>
          <p className="text-success font-bold">Task Approved!</p>
          <p className="text-secondary">Payout is pending processing.</p>
        </div>
      )}

      {status === 'paid' && (
        <div className="text-center">
          <div className="empty-state-icon">💰</div>
          <p className="text-success font-bold">Task Completed & Paid!</p>
          <p className="text-secondary">The agent has received their USDC payout.</p>
        </div>
      )}

      {status === 'rejected' && (
        <div className="text-center">
          <div className="empty-state-icon">❌</div>
          <p className="text-error font-bold">Submission Rejected</p>
          <p className="text-secondary">The proof was not accepted.</p>
        </div>
      )}
    </div>
  );
}

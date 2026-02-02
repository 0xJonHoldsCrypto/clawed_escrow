'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.API_URL || 'https://clawedescrow-production.up.railway.app';

export default function TaskActions({ taskId, status }: { taskId: string; status: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [claimId, setClaimId] = useState('');

  async function handleClaim(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = e.currentTarget;
    const formData = new FormData(form);

    try {
      const res = await fetch(`${API_URL}/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: {
            type: 'wallet',
            id: formData.get('wallet') as string,
          },
        }),
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
      const res = await fetch(`${API_URL}/v1/claims/${formData.get('claimId')}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'url',
          payload: formData.get('proof'),
        }),
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
      const res = await fetch(`${API_URL}/v1/claims/${formData.get('claimId')}/approve`, {
        method: 'POST',
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
      const res = await fetch(`${API_URL}/v1/claims/${claimIdToReject}/reject`, {
        method: 'POST',
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

  return (
    <div className="card mt-2">
      <h2>Actions</h2>

      {error && (
        <p style={{ color: 'var(--error)' }} className="mb-1">{error}</p>
      )}

      {status === 'open' && (
        <form onSubmit={handleClaim}>
          <p className="text-muted mb-1">Claim this task to start working on it.</p>
          <input
            type="text"
            name="wallet"
            placeholder="Your wallet address (0x...)"
            required
            pattern="^0x[a-fA-F0-9]{40}$"
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Claiming...' : 'Claim Task'}
          </button>
        </form>
      )}

      {status === 'claimed' && (
        <form onSubmit={handleSubmit}>
          <p className="text-muted mb-1">Submit proof that you completed the task.</p>
          <input
            type="text"
            name="claimId"
            placeholder="Claim ID"
            required
            defaultValue={claimId}
          />
          <textarea
            name="proof"
            placeholder="Proof URL or description..."
            required
            rows={3}
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Submitting...' : 'Submit Proof'}
          </button>
        </form>
      )}

      {status === 'submitted' && (
        <form onSubmit={handleApprove}>
          <p className="text-muted mb-1">Review the submission and approve or reject.</p>
          <input
            type="text"
            name="claimId"
            placeholder="Claim ID"
            required
          />
          <div className="flex gap-2">
            <button type="submit" className="btn btn-success" disabled={loading}>
              {loading ? 'Processing...' : '✓ Approve'}
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
        <p className="text-muted">This task has been approved. Payout pending.</p>
      )}

      {status === 'paid' && (
        <p style={{ color: 'var(--success)' }}>✓ This task has been completed and paid.</p>
      )}

      {status === 'rejected' && (
        <p style={{ color: 'var(--error)' }}>This submission was rejected.</p>
      )}
    </div>
  );
}

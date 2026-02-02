'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

const API_URL = process.env.API_URL || 'https://clawedescrow-production.up.railway.app';

export default function NewTask() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const form = e.currentTarget;
    const formData = new FormData(form);

    const task = {
      title: formData.get('title') as string,
      instructions: formData.get('instructions') as string,
      tags: (formData.get('tags') as string).split(',').map(t => t.trim()).filter(Boolean),
      payout: {
        amount: formData.get('amount') as string,
        currency: 'USDC_BASE' as const,
      },
      requester: {
        type: 'wallet',
        id: formData.get('wallet') as string,
      },
    };

    try {
      const res = await fetch(`${API_URL}/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to create task');
      }

      const data = await res.json();
      router.push(`/tasks/${data.task.id}`);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <>
      <nav>
        <div className="flex-between">
          <Link href="/" className="logo">🔒 Clawed Escrow</Link>
        </div>
      </nav>
      <div className="container">
        <h1>Create New Task</h1>

        {error && (
          <div className="card" style={{ borderColor: 'var(--error)' }}>
            <p style={{ color: 'var(--error)' }}>{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="card">
          <div>
            <label htmlFor="title">Title</label>
            <input
              type="text"
              id="title"
              name="title"
              placeholder="What needs to be done?"
              required
              maxLength={200}
            />
          </div>

          <div>
            <label htmlFor="instructions">Instructions</label>
            <textarea
              id="instructions"
              name="instructions"
              placeholder="Detailed instructions for completing the task..."
              required
              rows={5}
            />
          </div>

          <div>
            <label htmlFor="tags">Tags (comma-separated)</label>
            <input
              type="text"
              id="tags"
              name="tags"
              placeholder="social, twitter, engagement"
            />
          </div>

          <div>
            <label htmlFor="amount">Payout (USDC)</label>
            <input
              type="text"
              id="amount"
              name="amount"
              placeholder="5.00"
              required
              pattern="^\d+(\.\d{1,2})?$"
            />
          </div>

          <div>
            <label htmlFor="wallet">Your Wallet Address</label>
            <input
              type="text"
              id="wallet"
              name="wallet"
              placeholder="0x..."
              required
              pattern="^0x[a-fA-F0-9]{40}$"
            />
            <p className="text-muted text-sm">This wallet will be used to fund the escrow and approve submissions.</p>
          </div>

          <div className="flex gap-2 mt-2">
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Creating...' : 'Create Task'}
            </button>
            <Link href="/" className="btn btn-secondary">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </>
  );
}

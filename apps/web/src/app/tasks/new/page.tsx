'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAccount, useSignMessage } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Header } from '@/components/Header';
import { buildAuthHeaders } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

export default function NewTask() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    
    if (!isConnected || !address) {
      setError('Please connect your wallet first');
      return;
    }
    
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
        id: address,
      },
    };

    try {
      const headers = await buildAuthHeaders({
        address,
        signMessageAsync,
        method: 'POST',
        path: '/v1/tasks',
        body: task,
      });

      const res = await fetch(`${API_URL}/v1/tasks`, {
        method: 'POST',
        headers,
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
      <Header />
      <div className="container container-sm">
        <div className="page-header">
          <h1>Create New Task</h1>
          <p>Post a task and fund it with USDC to have agents complete it.</p>
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
              <label htmlFor="title">Task Title</label>
              <input
                type="text"
                id="title"
                name="title"
                placeholder="What needs to be done?"
                required
                maxLength={200}
              />
            </div>

            <div className="form-group">
              <label htmlFor="instructions">
                Instructions
                <span className="label-hint"> — Be specific about what you need</span>
              </label>
              <textarea
                id="instructions"
                name="instructions"
                placeholder="Detailed instructions for completing the task. Include any requirements, deliverables, or examples..."
                required
                rows={6}
              />
            </div>

            <div className="form-group">
              <label htmlFor="tags">
                Tags
                <span className="label-hint"> — Comma-separated</span>
              </label>
              <input
                type="text"
                id="tags"
                name="tags"
                placeholder="social, twitter, engagement"
              />
            </div>

            <div className="form-group">
              <label htmlFor="amount">Payout Amount (USDC)</label>
              <div className="input-with-addon">
                <span className="input-addon">💵</span>
                <input
                  type="text"
                  id="amount"
                  name="amount"
                  placeholder="5.00"
                  required
                  pattern="^\d+(\.\d{1,6})?$"
                />
              </div>
              <p className="text-muted text-sm mt-1">
                A 2% protocol fee will be added. You'll fund: payout + fee.
              </p>
            </div>

            <div className="form-group">
              <label>Your Wallet</label>
              <div className="deposit-box">
                <p className="deposit-address">{address}</p>
                <p className="text-muted text-sm">
                  This wallet will receive the escrow refund if the task is cancelled.
                </p>
              </div>
            </div>

            <div className="flex gap-2 mt-3">
              <button type="submit" className="btn btn-primary btn-lg" disabled={loading}>
                {loading ? 'Creating...' : 'Create Task'}
              </button>
              <Link href="/" className="btn btn-secondary btn-lg">
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

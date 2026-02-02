'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.API_URL || 'https://clawedescrow-production.up.railway.app';

interface Props {
  taskId: string;
  depositAddress: string;
  requiredAmount: string;
  payout: string;
  fee: string;
}

export default function FundingStatus({ taskId, depositAddress, requiredAmount, payout, fee }: Props) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');

  async function checkFunding() {
    setChecking(true);
    setMessage('');

    try {
      const res = await fetch(`${API_URL}/v1/tasks/${taskId}/check-funding`, {
        method: 'POST',
      });
      const data = await res.json();

      if (data.funded) {
        setMessage('✓ Funding confirmed! Refreshing...');
        setTimeout(() => router.refresh(), 1000);
      } else {
        setMessage('No confirmed funding found yet. Make sure you sent USDC on Base and wait for 6 confirmations.');
      }
    } catch (err) {
      setMessage('Error checking funding status');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="card mt-2" style={{ borderColor: 'var(--warning)' }}>
      <h2>⏳ Awaiting Funding</h2>
      <p className="text-muted mb-2">
        This task needs to be funded before agents can claim it. Send USDC on Base to the deposit address below.
      </p>

      <div style={{ background: 'var(--bg)', padding: '1rem', borderRadius: '6px', marginBottom: '1rem' }}>
        <p className="text-sm text-muted mb-1">Deposit Address (Base)</p>
        <p className="mono" style={{ fontSize: '0.9rem', wordBreak: 'break-all' }}>
          {depositAddress}
        </p>
      </div>

      <div className="flex-between mb-2">
        <div>
          <p className="text-sm text-muted">Payout to Agent</p>
          <p><strong>{payout} USDC</strong></p>
        </div>
        <div>
          <p className="text-sm text-muted">Protocol Fee (2%)</p>
          <p><strong>{fee} USDC</strong></p>
        </div>
        <div>
          <p className="text-sm text-muted">Total Required</p>
          <p style={{ color: 'var(--warning)' }}><strong>{requiredAmount} USDC</strong></p>
        </div>
      </div>

      <div className="flex gap-2">
        <button 
          onClick={checkFunding} 
          className="btn btn-primary" 
          disabled={checking}
        >
          {checking ? 'Checking...' : 'Check Funding Status'}
        </button>
        <a 
          href={`https://basescan.org/address/${depositAddress}`} 
          target="_blank" 
          rel="noopener"
          className="btn btn-secondary"
        >
          View on BaseScan
        </a>
      </div>

      {message && (
        <p className="mt-2 text-sm" style={{ color: message.includes('✓') ? 'var(--success)' : 'var(--text-muted)' }}>
          {message}
        </p>
      )}
    </div>
  );
}

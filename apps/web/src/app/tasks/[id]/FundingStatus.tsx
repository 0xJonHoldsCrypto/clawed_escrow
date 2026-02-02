'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

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
        setTimeout(() => router.refresh(), 1500);
      } else {
        setMessage('No confirmed funding found. Make sure you sent USDC on Base and wait for 6 confirmations (~12 seconds).');
      }
    } catch (err) {
      setMessage('Error checking funding status. Please try again.');
    } finally {
      setChecking(false);
    }
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(depositAddress);
    setMessage('Address copied!');
    setTimeout(() => setMessage(''), 2000);
  }

  return (
    <div className="card card-warning mt-2">
      <h2>⏳ Fund This Task</h2>
      <p className="text-secondary mb-3">
        Send USDC on <strong>Base</strong> to the deposit address below. Once confirmed, agents can claim this task.
      </p>

      <div className="deposit-box mb-3">
        <p className="text-muted text-sm mb-1">Deposit Address (Base Network)</p>
        <p className="deposit-address">{depositAddress}</p>
        <button onClick={copyAddress} className="btn btn-secondary btn-sm mt-1">
          📋 Copy Address
        </button>
      </div>

      <div className="stats-grid mb-3">
        <div className="stat-item">
          <div className="stat-value text-success">{payout}</div>
          <div className="stat-label">Agent Payout</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{fee}</div>
          <div className="stat-label">Protocol Fee</div>
        </div>
        <div className="stat-item">
          <div className="stat-value text-warning">{requiredAmount}</div>
          <div className="stat-label">Total to Send</div>
        </div>
      </div>

      <div className="flex gap-2">
        <button 
          onClick={checkFunding} 
          className="btn btn-primary" 
          disabled={checking}
        >
          {checking ? '🔄 Checking...' : '🔍 Check Funding Status'}
        </button>
        <a 
          href={`https://basescan.org/address/${depositAddress}`} 
          target="_blank" 
          rel="noopener"
          className="btn btn-secondary"
        >
          View on BaseScan →
        </a>
      </div>

      {message && (
        <p className={`mt-2 text-sm ${message.includes('✓') || message.includes('copied') ? 'text-success' : 'text-secondary'}`}>
          {message}
        </p>
      )}
    </div>
  );
}

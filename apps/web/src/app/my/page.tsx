'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { formatUnits } from 'viem';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

type V2TaskRow = {
  task_id: string;
  requester: string | null;
  payout_amount: string | null;
  max_winners: number | null;
  deadline: number | null;
  status: number | null;
  title?: string | null;
  instructions?: string | null;
};

function mapTaskStatus(n: any): string {
  // enum TaskStatus { None, Created, Funded, Cancelled, Completed, Closed }
  const v = Number(n);
  if (v === 1) return 'created';
  if (v === 2) return 'funded';
  if (v === 3) return 'cancelled';
  if (v === 4) return 'completed';
  if (v === 5) return 'closed';
  return 'unknown';
}

export default function MyTasksPage() {
  const { address, isConnected } = useAccount();
  const [rows, setRows] = useState<V2TaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addr = (address || '').toLowerCase();

  useEffect(() => {
    async function run() {
      if (!addr) {
        setRows([]);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const res = await fetch(`${API_URL}/v2/wallets/${addr}/tasks?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load tasks');
        const data = await res.json();
        setRows(data.tasks || []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    }
    run();
  }, [addr]);

  const created = useMemo(() => rows.filter((r) => (r.requester || '').toLowerCase() === addr), [rows, addr]);

  const contributed = useMemo(() => rows.filter((r) => (r.requester || '').toLowerCase() !== addr), [rows, addr]);

  return (
    <div className="container">
      <div className="page-header">
        <h1>My Tasks</h1>
        <p>All tasks you created (requester) and tasks you’ve participated in (agent).</p>
      </div>

      {!isConnected ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">🔗</div>
            <div className="empty-state-title">Connect Wallet</div>
            <p className="mb-2">Connect your wallet to see your tasks.</p>
            <ConnectButton />
          </div>
        </div>
      ) : (
        <>
          {error && (
            <div className="card card-error mb-2">
              <p className="text-error">{error}</p>
            </div>
          )}

          <h2>Created by me</h2>
          {loading ? (
            <p className="text-muted">Loading…</p>
          ) : created.length === 0 ? (
            <p className="text-muted">No tasks created by this wallet yet.</p>
          ) : (
            created.map((t) => {
              const payout = t.payout_amount ? formatUnits(BigInt(t.payout_amount), 6) : '0.00';
              return (
                <Link key={t.task_id} href={`/tasks/${t.task_id}`} className="task-card">
                  <div className="card card-clickable">
                    <div className="task-card-header">
                      <div>
                        <h3 className="task-card-title" style={{ marginBottom: 0 }}>{(t.title || '').trim() || 'Untitled task'}</h3>
                        <div className="text-muted text-sm">Task #{t.task_id}</div>
                      </div>
                      <span className={`badge badge-${mapTaskStatus(t.status)}`}>{mapTaskStatus(t.status)}</span>
                    </div>
                    <p className="task-card-description">
                      <span className="text-muted">
                        {(t.instructions || '').trim()
                          ? `${String(t.instructions).slice(0, 160)}${String(t.instructions).length > 160 ? '…' : ''}`
                          : 'No description saved yet.'}
                      </span>
                      <br />
                      payout: {payout} USDC
                    </p>
                  </div>
                </Link>
              );
            })
          )}

          <h2 className="mt-3">I participated (agent)</h2>
          {loading ? (
            <p className="text-muted">Loading…</p>
          ) : contributed.length === 0 ? (
            <p className="text-muted">No participated tasks found for this wallet yet.</p>
          ) : (
            contributed.map((t) => {
              const payout = t.payout_amount ? formatUnits(BigInt(t.payout_amount), 6) : '0.00';
              return (
                <Link key={t.task_id} href={`/tasks/${t.task_id}`} className="task-card">
                  <div className="card card-clickable">
                    <div className="task-card-header">
                      <div>
                        <h3 className="task-card-title" style={{ marginBottom: 0 }}>{(t.title || '').trim() || 'Untitled task'}</h3>
                        <div className="text-muted text-sm">Task #{t.task_id}</div>
                      </div>
                      <span className={`badge badge-${mapTaskStatus(t.status)}`}>{mapTaskStatus(t.status)}</span>
                    </div>
                    <p className="task-card-description">
                      <span className="text-muted">
                        {(t.instructions || '').trim()
                          ? `${String(t.instructions).slice(0, 160)}${String(t.instructions).length > 160 ? '…' : ''}`
                          : 'No description saved yet.'}
                      </span>
                      <br />
                      requester: {t.requester ? `${t.requester.slice(0, 6)}...${t.requester.slice(-4)}` : '—'} · payout: {payout} USDC
                    </p>
                  </div>
                </Link>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

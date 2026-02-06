import Link from 'next/link';
import { getTask, getTaskEvents } from '@/lib/api';
import { notFound } from 'next/navigation';
// Header is rendered by the root layout
import { formatUnits } from 'viem';
import { ESCROW_ADDRESS } from '@/lib/contracts';
import TaskActionsV2 from './TaskActionsV2';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) notFound();

  const events = await getTaskEvents(id);
  const payout = task.payoutAmount ? formatUnits(BigInt(task.payoutAmount), 6) : '0.00';
  const balance = task.balance ? formatUnits(BigInt(task.balance), 6) : '0.00';

  return (
    <div className="container">
        <Link href="/" className="btn btn-ghost btn-sm mb-2">
          ← Back to Tasks
        </Link>

        <div className="card card-highlight">
          <div className="flex-between mb-2">
            <h1 style={{ marginBottom: 0 }}>Task #{task.id}</h1>
            <StatusBadge status={task.status} />
          </div>

          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value text-success">{payout}</div>
              <div className="stat-label">Payout (USDC)</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{task.maxWinners ?? '—'}</div>
              <div className="stat-label">Max Winners</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{balance}</div>
              <div className="stat-label">Escrow Balance (USDC)</div>
            </div>
            <div className="stat-item">
              <div className="stat-value font-mono text-sm">
                {task.requester ? `${task.requester.slice(0, 6)}...${task.requester.slice(-4)}` : '—'}
              </div>
              <div className="stat-label">Requester</div>
            </div>
          </div>

          <div className="mt-2">
            <p className="text-muted text-sm">
              Escrow contract: <a href={`https://basescan.org/address/${ESCROW_ADDRESS}`} target="_blank" rel="noopener">{ESCROW_ADDRESS}</a>
            </p>
            {task.createdTx && (
              <p className="text-muted text-sm">
                Created tx: <a href={`https://basescan.org/tx/${task.createdTx}`} target="_blank" rel="noopener">{task.createdTx.slice(0, 10)}…</a>
              </p>
            )}
            {task.specHash && (
              <p className="text-muted text-sm">specHash: <span className="font-mono">{task.specHash}</span></p>
            )}
          </div>
        </div>

        <div className="card mt-2">
          <h2>Onchain Events (indexed)</h2>
          {events.length === 0 ? (
            <p className="text-muted">No indexed events yet.</p>
          ) : (
            <div>
              {events.map((e: any) => (
                <div key={`${e.tx_hash}:${e.log_index}`} className="activity-item">
                  <div>
                    <span className="activity-type">{e.event_name}</span>
                    <span className="activity-actor"> block {e.block_number}</span>
                  </div>
                  <span className="activity-time">
                    <a href={`https://basescan.org/tx/${e.tx_hash}`} target="_blank" rel="noopener">{e.tx_hash.slice(0, 10)}…</a>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <TaskActionsV2 taskId={task.id} requester={task.requester} payoutAmount={task.payoutAmount} />
    </div>
  );
}

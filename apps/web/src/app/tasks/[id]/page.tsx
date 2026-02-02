import Link from 'next/link';
import { getTask, getTaskEvents } from '@/lib/api';
import { notFound } from 'next/navigation';
import TaskActions from './TaskActions';
import FundingStatus from './FundingStatus';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export default async function TaskPage({ params }: { params: { id: string } }) {
  const task = await getTask(params.id);
  if (!task) notFound();

  const events = await getTaskEvents(params.id);

  return (
    <>
      <nav>
        <div className="flex-between">
          <Link href="/" className="logo">🔒 Clawed Escrow</Link>
        </div>
      </nav>
      <div className="container">
        <div className="flex-between mb-2">
          <h1>{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>

        <div className="card">
          <h2>Details</h2>
          <p className="mb-2">{task.instructions}</p>

          <div className="flex gap-2 mb-2">
            {task.tags.map((tag) => (
              <span key={tag} className="badge" style={{ background: 'var(--border)' }}>
                {tag}
              </span>
            ))}
          </div>

          <div className="flex-between">
            <div>
              <p className="text-sm text-muted">Payout</p>
              <p><strong>{task.payout.amount} USDC</strong></p>
              {task.fee && (
                <p className="text-sm text-muted">+ {task.fee} fee</p>
              )}
            </div>
            <div>
              <p className="text-sm text-muted">Requester</p>
              <p className="mono text-sm">{task.requester.id.slice(0, 10)}...{task.requester.id.slice(-8)}</p>
            </div>
            <div>
              <p className="text-sm text-muted">Created</p>
              <p className="text-sm">{new Date(task.createdAt).toLocaleString()}</p>
            </div>
          </div>
        </div>

        {/* Funding section for draft tasks */}
        {task.status === 'draft' && task.deposit && (
          <FundingStatus 
            taskId={task.id}
            depositAddress={task.deposit.address}
            requiredAmount={task.requiredAmount || '0'}
            payout={task.payout.amount}
            fee={task.fee || '0'}
          />
        )}

        {/* Show funding info if funded */}
        {task.funding && (
          <div className="card mt-2" style={{ borderColor: 'var(--success)' }}>
            <h2>✓ Funded</h2>
            <p className="text-sm">
              <strong>{task.funding.amount} USDC</strong> received
              {task.funding.txHash && (
                <>
                  {' '}— <a href={`https://basescan.org/tx/${task.funding.txHash}`} target="_blank" rel="noopener" className="mono">
                    {task.funding.txHash.slice(0, 10)}...
                  </a>
                </>
              )}
            </p>
          </div>
        )}

        <TaskActions taskId={task.id} status={task.status} />

        <div className="card mt-2">
          <h2>Activity</h2>
          {events.length === 0 ? (
            <p className="text-muted">No activity yet.</p>
          ) : (
            <div>
              {events.map((event) => (
                <div key={event.id} className="mb-1" style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
                  <div className="flex-between">
                    <span className="text-sm">
                      <strong>{event.type}</strong>
                      {' by '}
                      <span className="mono">{event.actor.type}:{event.actor.id.slice(0, 8)}...</span>
                    </span>
                    <span className="text-muted text-sm">
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2">
          <Link href="/" className="btn btn-secondary">← Back to Tasks</Link>
        </div>
      </div>
    </>
  );
}

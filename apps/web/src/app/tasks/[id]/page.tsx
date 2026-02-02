import Link from 'next/link';
import { getTask, getTaskEvents } from '@/lib/api';
import { notFound } from 'next/navigation';
import { Header } from '@/components/Header';
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
      <Header />
      <div className="container">
        <Link href="/" className="btn btn-ghost btn-sm mb-2">
          ← Back to Tasks
        </Link>

        <div className="card card-highlight">
          <div className="flex-between mb-2">
            <h1 style={{ marginBottom: 0 }}>{task.title}</h1>
            <StatusBadge status={task.status} />
          </div>

          <p className="text-secondary mb-3" style={{ whiteSpace: 'pre-wrap' }}>
            {task.instructions}
          </p>

          {task.tags.length > 0 && (
            <div className="flex gap-1 mb-3">
              {task.tags.map((tag) => (
                <span key={tag} className="badge" style={{ background: 'var(--bg-secondary)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value text-success">{task.payout.amount}</div>
              <div className="stat-label">USDC Payout</div>
            </div>
            {task.fee && (
              <div className="stat-item">
                <div className="stat-value">{task.fee}</div>
                <div className="stat-label">Fee (2%)</div>
              </div>
            )}
            <div className="stat-item">
              <div className="stat-value font-mono text-sm">
                {task.requester.id.slice(0, 6)}...{task.requester.id.slice(-4)}
              </div>
              <div className="stat-label">Requester</div>
            </div>
            <div className="stat-item">
              <div className="stat-value text-sm">
                {new Date(task.createdAt).toLocaleDateString()}
              </div>
              <div className="stat-label">Created</div>
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
          <div className="card card-success mt-2">
            <div className="flex-between">
              <div>
                <h2 style={{ marginBottom: '0.25rem' }}>✓ Funded</h2>
                <p className="text-sm text-secondary">
                  {task.funding.amount} USDC received
                </p>
              </div>
              {task.funding.txHash && (
                <a 
                  href={`https://basescan.org/tx/${task.funding.txHash}`} 
                  target="_blank" 
                  rel="noopener" 
                  className="btn btn-secondary btn-sm"
                >
                  View on BaseScan →
                </a>
              )}
            </div>
          </div>
        )}

        <TaskActions taskId={task.id} status={task.status} />

        <div className="card mt-2">
          <h2>Activity Log</h2>
          {events.length === 0 ? (
            <p className="text-muted">No activity yet.</p>
          ) : (
            <div>
              {events.map((event) => (
                <div key={event.id} className="activity-item">
                  <div>
                    <span className="activity-type">{event.type}</span>
                    <span className="activity-actor">
                      {' '}by {event.actor.type}:{event.actor.id.slice(0, 8)}...
                    </span>
                  </div>
                  <span className="activity-time">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

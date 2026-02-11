import Link from 'next/link';
import { getTasks, V2Task } from '@/lib/api';
import { formatUnits } from 'viem';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function TaskCard({ task }: { task: V2Task }) {
  const payout = task.payoutAmount ? formatUnits(BigInt(task.payoutAmount), 6) : '0.00';
  const title = (task.title || '').trim() || 'Untitled task';
  const description = (task.instructions || '').trim();

  return (
    <Link href={`/tasks/${task.id}`} className="task-card">
      <div className="card card-clickable">
        <div className="task-card-header">
          <div>
            <h3 className="task-card-title" style={{ marginBottom: 0 }}>{title}</h3>
            <div className="text-muted text-sm">Task #{task.id}</div>
          </div>
          <StatusBadge status={task.status} />
        </div>

        <p className="task-card-description">
          <span className="text-muted">
            {description ? (
              <>
                {description.slice(0, 160)}
                {description.length > 160 ? '…' : ''}
              </>
            ) : (
              <>No description saved yet.</>
            )}
          </span>
        </p>

        <div className="task-card-footer">
          <div className="task-payout">💰 {payout} USDC</div>
          <span className="task-meta">
            requester: {task.requester ? `${task.requester.slice(0, 6)}...${task.requester.slice(-4)}` : '—'}
            {task.deadline ? ` · deadline: ${new Date(task.deadline * 1000).toLocaleDateString()}` : ''}
          </span>
        </div>
      </div>
    </Link>
  );
}

export default async function Home() {
  const tasks = await getTasks();
  const hideIds = (process.env.NEXT_PUBLIC_HIDE_TASK_IDS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const visibleTasks = hideIds.length ? tasks.filter((t) => !hideIds.includes(String(t.id))) : tasks;

  return (
    <div className="container">
      <div className="page-header">
        <h1>Onchain Task Board</h1>
        <p>Tasks are enforced by the ClawedEscrow contract on Base. The web app reads onchain state and shows task activity.</p>
      </div>

      <h2>📋 Tasks</h2>
      {visibleTasks.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <div className="empty-state-title">No tasks yet</div>
            <p>Create your first task to start.</p>
          </div>
        </div>
      ) : (
        visibleTasks.map((task) => <TaskCard key={task.id} task={task} />)
      )}
    </div>
  );
}

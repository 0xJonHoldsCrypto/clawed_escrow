import Link from 'next/link';
import { getTasks, V2Task } from '@/lib/api';
import { Header } from '@/components/Header';
import { formatUnits } from 'viem';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function TaskCard({ task }: { task: V2Task }) {
  const payout = task.payoutAmount ? formatUnits(BigInt(task.payoutAmount), 6) : '0.00';

  return (
    <Link href={`/tasks/${task.id}`} className="task-card">
      <div className="card card-clickable">
        <div className="task-card-header">
          <h3 className="task-card-title">Task #{task.id}</h3>
          <StatusBadge status={task.status} />
        </div>

        <p className="task-card-description">
          requester: {task.requester ? `${task.requester.slice(0, 6)}...${task.requester.slice(-4)}` : '—'}
        </p>

        <div className="task-card-footer">
          <div className="task-payout">💰 {payout} USDC</div>
          <span className="task-meta">
            {task.deadline ? `deadline: ${new Date(task.deadline * 1000).toLocaleDateString()}` : ''}
          </span>
        </div>
      </div>
    </Link>
  );
}

export default async function Home() {
  const tasks = await getTasks();

  return (
    <>
      <Header />
      <div className="container">
        <div className="page-header">
          <h1>Onchain Task Board</h1>
          <p>Tasks are managed by the ClawedEscrow contract on Base (metadata is hash-only for now).</p>
        </div>

        <h2>📋 Tasks</h2>
        {tasks.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">📭</div>
              <div className="empty-state-title">No tasks yet</div>
              <p>Create a new onchain task to start testing.</p>
            </div>
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </>
  );
}

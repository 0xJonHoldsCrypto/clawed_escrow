import Link from 'next/link';
import { getTasks, Task } from '@/lib/api';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function TaskCard({ task }: { task: Task }) {
  return (
    <Link href={`/tasks/${task.id}`}>
      <div className="card">
        <div className="flex-between mb-1">
          <h3>{task.title}</h3>
          <StatusBadge status={task.status} />
        </div>
        <p className="text-muted text-sm mb-1">
          {task.instructions.slice(0, 150)}
          {task.instructions.length > 150 ? '...' : ''}
        </p>
        <div className="flex-between">
          <span className="text-sm">
            💰 <strong>{task.payout.amount} USDC</strong>
            {task.status === 'draft' && (
              <span className="text-muted"> (awaiting funding)</span>
            )}
          </span>
          <span className="text-muted text-sm">
            {new Date(task.createdAt).toLocaleDateString()}
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
      <nav>
        <div className="flex-between">
          <span className="logo">🔒 Clawed Escrow</span>
          <Link href="/tasks/new" className="btn btn-primary">
            + Create Task
          </Link>
        </div>
      </nav>
      <div className="container">
        <h1>Tasks</h1>
        {tasks.length === 0 ? (
          <div className="card">
            <p className="text-muted">No tasks yet. Create one to get started!</p>
          </div>
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </div>
    </>
  );
}

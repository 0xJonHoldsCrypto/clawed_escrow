import Link from 'next/link';
import { getTasks, Task } from '@/lib/api';
import { Header } from '@/components/Header';

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function TaskCard({ task }: { task: Task }) {
  return (
    <Link href={`/tasks/${task.id}`} className="task-card">
      <div className="card card-clickable">
        <div className="task-card-header">
          <h3 className="task-card-title">{task.title}</h3>
          <StatusBadge status={task.status} />
        </div>
        <p className="task-card-description">
          {task.instructions}
        </p>
        <div className="task-card-footer">
          <div className="task-payout">
            💰 {task.payout.amount} USDC
            {task.status === 'draft' && (
              <span className="text-muted text-sm">(awaiting funding)</span>
            )}
          </div>
          <span className="task-meta">
            {new Date(task.createdAt).toLocaleDateString()}
          </span>
        </div>
      </div>
    </Link>
  );
}

export default async function Home() {
  const tasks = await getTasks();
  
  const openTasks = tasks.filter(t => t.status === 'open');
  const activeTasks = tasks.filter(t => ['claimed', 'submitted'].includes(t.status));
  const draftTasks = tasks.filter(t => t.status === 'draft');

  return (
    <>
      <Header />
      <div className="container">
        <div className="page-header">
          <h1>Task Board</h1>
          <p>Browse available tasks, claim work, and earn USDC on Base.</p>
        </div>

        {/* Stats */}
        <div className="stats-grid mb-3">
          <div className="stat-item">
            <div className="stat-value">{openTasks.length}</div>
            <div className="stat-label">Open Tasks</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{activeTasks.length}</div>
            <div className="stat-label">In Progress</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">
              {tasks.reduce((sum, t) => sum + parseFloat(t.payout.amount), 0).toFixed(2)}
            </div>
            <div className="stat-label">USDC in Escrow</div>
          </div>
        </div>

        {/* Open Tasks */}
        <h2>🟢 Open Tasks</h2>
        {openTasks.length === 0 ? (
          <div className="card">
            <div className="empty-state">
              <div className="empty-state-icon">📭</div>
              <div className="empty-state-title">No open tasks</div>
              <p>Create a new task or wait for tasks to be funded.</p>
            </div>
          </div>
        ) : (
          openTasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}

        {/* Active Tasks */}
        {activeTasks.length > 0 && (
          <>
            <h2 className="mt-3">🔄 In Progress</h2>
            {activeTasks.map((task) => <TaskCard key={task.id} task={task} />)}
          </>
        )}

        {/* Draft Tasks */}
        {draftTasks.length > 0 && (
          <>
            <h2 className="mt-3">⏳ Awaiting Funding</h2>
            {draftTasks.map((task) => <TaskCard key={task.id} task={task} />)}
          </>
        )}
      </div>
    </>
  );
}

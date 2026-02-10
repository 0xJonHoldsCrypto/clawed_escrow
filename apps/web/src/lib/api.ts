const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

// ===== V2 (onchain projection) =====
// Note: onchain tasks do not store title/instructions. The contract stores only specHash.

export type V2TaskStatus = 'created' | 'funded' | 'cancelled' | 'completed' | 'closed' | 'unknown';

export interface V2Task {
  id: string; // task_id (as string)
  status: V2TaskStatus;
  requester: string | null;
  payoutAmount: string | null; // USDC minor units as string
  maxWinners: number | null;
  deadline: number | null; // unix seconds
  reviewWindow: number | null;
  escalationWindow: number | null;
  approvedCount: number | null;
  withdrawnCount: number | null;
  pendingSubmissions: number | null;
  submissionCount: number | null;
  claimCount: number | null;
  specHash: string | null;
  balance: string | null; // USDC minor units as string
  title: string | null;
  instructions: string | null;
  createdTx: string | null;
  createdBlock: number | null;
  updatedTx: string | null;
  updatedBlock: number | null;
}

function mapTaskStatus(n: any): V2TaskStatus {
  // enum TaskStatus { None, Created, Funded, Cancelled, Completed, Closed }
  const v = Number(n);
  if (v === 1) return 'created';
  if (v === 2) return 'funded';
  if (v === 3) return 'cancelled';
  if (v === 4) return 'completed';
  if (v === 5) return 'closed';
  return 'unknown';
}

function toNum(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function hydrateV2Task(row: any): V2Task {
  return {
    id: String(row.task_id),
    status: mapTaskStatus(row.status),
    requester: row.requester || null,
    payoutAmount: row.payout_amount ?? null,
    maxWinners: toNum(row.max_winners),
    deadline: toNum(row.deadline),
    reviewWindow: toNum(row.review_window),
    escalationWindow: toNum(row.escalation_window),
    approvedCount: toNum(row.approved_count),
    withdrawnCount: toNum(row.withdrawn_count),
    pendingSubmissions: toNum(row.pending_submissions),
    submissionCount: toNum(row.submission_count),
    claimCount: toNum(row.claim_count),
    specHash: row.spec_hash ?? null,
    balance: row.balance ?? null,
    title: row.title ?? null,
    instructions: row.instructions ?? null,
    createdTx: row.created_tx ?? null,
    createdBlock: toNum(row.created_block),
    updatedTx: row.updated_tx ?? null,
    updatedBlock: toNum(row.updated_block),
  };
}

export async function getTasks(): Promise<V2Task[]> {
  const res = await fetch(`${API_URL}/v2/tasks`, { cache: 'no-store' });
  const data = await res.json();
  return (data.tasks || []).map(hydrateV2Task);
}

export async function getTask(id: string): Promise<V2Task | null> {
  const res = await fetch(`${API_URL}/v2/tasks/${id}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.task ? hydrateV2Task(data.task) : null;
}

export async function getTaskEvents(taskId: string): Promise<any[]> {
  const res = await fetch(`${API_URL}/v2/tasks/${taskId}/events`, { cache: 'no-store' });
  const data = await res.json();
  return data.events || [];
}

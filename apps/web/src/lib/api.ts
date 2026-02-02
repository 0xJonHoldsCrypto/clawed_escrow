const API_URL = process.env.API_URL || 'https://clawedescrow-production.up.railway.app';

export interface Task {
  id: string;
  status: string;
  title: string;
  instructions: string;
  tags: string[];
  payout: { amount: string; currency: string };
  fee: string | null;
  requiredAmount: string | null;
  requester: { type: string; id: string };
  approver: { type: string; id: string };
  deposit: { address: string; index: number } | null;
  funding: { txHash: string | null; amount: string; at: string } | null;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Claim {
  id: string;
  taskId: string;
  status: string;
  agent: { type: string; id: string };
  claimedAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  submission: { kind: string; payload: any; hash: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export async function getTasks(status?: string): Promise<Task[]> {
  const url = status ? `${API_URL}/v1/tasks?status=${status}` : `${API_URL}/v1/tasks`;
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  return data.tasks;
}

export async function getTask(id: string): Promise<Task | null> {
  const res = await fetch(`${API_URL}/v1/tasks/${id}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  return data.task;
}

export async function createTask(task: {
  title: string;
  instructions: string;
  tags?: string[];
  payout: { amount: string; currency: string };
  requester: { type: string; id: string };
}): Promise<Task> {
  const res = await fetch(`${API_URL}/v1/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  const data = await res.json();
  return data.task;
}

export async function claimTask(taskId: string, agent: { type: string; id: string }): Promise<Claim> {
  const res = await fetch(`${API_URL}/v1/tasks/${taskId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  });
  const data = await res.json();
  return data.claim;
}

export async function submitProof(claimId: string, submission: { kind: string; payload: any }): Promise<Claim> {
  const res = await fetch(`${API_URL}/v1/claims/${claimId}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submission),
  });
  const data = await res.json();
  return data.claim;
}

export async function approveClaim(claimId: string): Promise<Claim> {
  const res = await fetch(`${API_URL}/v1/claims/${claimId}/approve`, {
    method: 'POST',
  });
  const data = await res.json();
  return data.claim;
}

export async function rejectClaim(claimId: string): Promise<Claim> {
  const res = await fetch(`${API_URL}/v1/claims/${claimId}/reject`, {
    method: 'POST',
  });
  const data = await res.json();
  return data.claim;
}

export async function getTaskEvents(taskId: string): Promise<any[]> {
  const res = await fetch(`${API_URL}/v1/tasks/${taskId}/events`, { cache: 'no-store' });
  const data = await res.json();
  return data.events;
}

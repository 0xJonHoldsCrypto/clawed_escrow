import express from 'express';
import { z } from 'zod';
import Database from 'better-sqlite3';

const PORT = process.env.PORT || 8787;
const SQLITE_PATH = process.env.SQLITE_PATH || './data.db';

const db = new Database(SQLITE_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  payout_amount TEXT NOT NULL,
  payout_currency TEXT NOT NULL,
  requester_type TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  approver_type TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  submission_kind TEXT,
  submission_payload TEXT,
  submission_hash TEXT,
  claimed_at TEXT NOT NULL,
  submitted_at TEXT,
  approved_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  claim_id TEXT,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(claim_id) REFERENCES claims(id)
);
`);

const app = express();
app.use(express.json({ limit: '1mb' }));

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function jsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function addEvent({ taskId, claimId = null, type, actor, data = {} }) {
  db.prepare(
    `INSERT INTO events (id, task_id, claim_id, type, actor_type, actor_id, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), taskId, claimId, type, actor.type, actor.id, JSON.stringify(data), nowIso());
}

// --- Schemas
const TaskCreate = z.object({
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20000),
  tags: z.array(z.string()).default([]),
  payout: z.object({
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    currency: z.literal('USDC_BASE')
  }),
  requester: z.object({ type: z.string(), id: z.string() }),
  approver: z.object({ type: z.string(), id: z.string() }).optional(),
  deadlineAt: z.string().datetime().optional()
});

const ClaimCreate = z.object({
  agent: z.object({ type: z.string(), id: z.string() })
});

const Submit = z.object({
  kind: z.enum(['text', 'url', 'json']),
  payload: z.any()
});

// --- Routes
app.get('/health', (req, res) => res.json({ ok: true, now: nowIso() }));

app.post('/v1/tasks', (req, res) => {
  const parsed = TaskCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const t = parsed.data;
  const id = uuid();
  const createdAt = nowIso();

  const approver = t.approver ?? { type: 'requester', id: t.requester.id };

  db.prepare(
    `INSERT INTO tasks (id, status, title, instructions, tags, payout_amount, payout_currency, requester_type, requester_id, approver_type, approver_id, deadline_at, created_at, updated_at)
     VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    t.title,
    t.instructions,
    JSON.stringify(t.tags),
    t.payout.amount,
    t.payout.currency,
    t.requester.type,
    t.requester.id,
    approver.type,
    approver.id,
    t.deadlineAt ?? null,
    createdAt,
    createdAt
  );

  addEvent({ taskId: id, type: 'task.created', actor: t.requester, data: { title: t.title } });

  res.status(201).json({ task: getTask(id) });
});

app.get('/v1/tasks', (req, res) => {
  const status = req.query.status;
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status)
    : db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all();

  res.json({ tasks: rows.map(hydrateTask) });
});

app.get('/v1/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  res.json({ task });
});

app.post('/v1/tasks/:id/claim', (req, res) => {
  const taskId = req.params.id;
  const task = getTaskRaw(taskId);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (task.status !== 'open') return res.status(409).json({ error: 'task_not_open' });

  const parsed = ClaimCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { agent } = parsed.data;

  // MVP: one active claim per task
  const existing = db.prepare('SELECT * FROM claims WHERE task_id = ? AND status IN (\'claimed\',\'submitted\')').get(taskId);
  if (existing) return res.status(409).json({ error: 'already_claimed' });

  const id = uuid();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO claims (id, task_id, status, agent_type, agent_id, claimed_at, created_at, updated_at)
     VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?)`
  ).run(id, taskId, agent.type, agent.id, ts, ts, ts);

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('claimed', ts, taskId);

  addEvent({ taskId, claimId: id, type: 'claim.created', actor: agent });

  res.status(201).json({ claim: getClaim(id), task: getTask(taskId) });
});

app.post('/v1/claims/:id/submit', (req, res) => {
  const claimId = req.params.id;
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  if (claim.status !== 'claimed') return res.status(409).json({ error: 'claim_not_claimed' });

  const parsed = Submit.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ts = nowIso();
  db.prepare(
    `UPDATE claims SET status='submitted', submission_kind=?, submission_payload=?, submitted_at=?, updated_at=? WHERE id=?`
  ).run(parsed.data.kind, JSON.stringify(parsed.data.payload), ts, ts, claimId);

  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('submitted', ts, claim.task_id);

  addEvent({ taskId: claim.task_id, claimId, type: 'claim.submitted', actor: { type: claim.agent_type, id: claim.agent_id } });

  res.json({ claim: getClaim(claimId), task: getTask(claim.task_id) });
});

app.post('/v1/claims/:id/approve', (req, res) => {
  const claimId = req.params.id;
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  if (claim.status !== 'submitted') return res.status(409).json({ error: 'claim_not_submitted' });

  const ts = nowIso();
  db.prepare(`UPDATE claims SET status='approved', approved_at=?, updated_at=? WHERE id=?`).run(ts, ts, claimId);
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('approved', ts, claim.task_id);

  addEvent({ taskId: claim.task_id, claimId, type: 'claim.approved', actor: { type: 'approver', id: 'manual' } });

  res.json({ claim: getClaim(claimId), task: getTask(claim.task_id) });
});

app.post('/v1/claims/:id/reject', (req, res) => {
  const claimId = req.params.id;
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
  if (!claim) return res.status(404).json({ error: 'not_found' });
  if (claim.status !== 'submitted') return res.status(409).json({ error: 'claim_not_submitted' });

  const ts = nowIso();
  db.prepare(`UPDATE claims SET status='rejected', updated_at=? WHERE id=?`).run(ts, claimId);
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('rejected', ts, claim.task_id);

  addEvent({ taskId: claim.task_id, claimId, type: 'claim.rejected', actor: { type: 'approver', id: 'manual' } });

  res.json({ claim: getClaim(claimId), task: getTask(claim.task_id) });
});

app.get('/v1/tasks/:id/events', (req, res) => {
  const rows = db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ events: rows.map(e => ({
    id: e.id,
    taskId: e.task_id,
    claimId: e.claim_id,
    type: e.type,
    actor: { type: e.actor_type, id: e.actor_id },
    data: jsonParse(e.data, {}),
    createdAt: e.created_at
  })) });
});

function hydrateTask(row) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    instructions: row.instructions,
    tags: jsonParse(row.tags, []),
    payout: { amount: row.payout_amount, currency: row.payout_currency },
    requester: { type: row.requester_type, id: row.requester_id },
    approver: { type: row.approver_type, id: row.approver_id },
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getTaskRaw(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

function getTask(id) {
  const row = getTaskRaw(id);
  return row ? hydrateTask(row) : null;
}

function getClaim(id) {
  const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
  if (!c) return null;
  return {
    id: c.id,
    taskId: c.task_id,
    status: c.status,
    agent: { type: c.agent_type, id: c.agent_id },
    claimedAt: c.claimed_at,
    submittedAt: c.submitted_at,
    approvedAt: c.approved_at,
    paidAt: c.paid_at,
    submission: c.submission_kind ? { kind: c.submission_kind, payload: jsonParse(c.submission_payload, null), hash: c.submission_hash } : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

app.listen(PORT, () => {
  console.log(`[clawed-escrow] listening on :${PORT} (sqlite: ${SQLITE_PATH})`);
});

import express from 'express';
import { z } from 'zod';
import pg from 'pg';

const { Pool } = pg;

const PORT = process.env.PORT || 8787;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Initialize tables
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]',
      payout_amount TEXT NOT NULL,
      payout_currency TEXT NOT NULL,
      requester_type TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      approver_type TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      deadline_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      status TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      submission_kind TEXT,
      submission_payload JSONB,
      submission_hash TEXT,
      claimed_at TIMESTAMPTZ NOT NULL,
      submitted_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      claim_id TEXT REFERENCES claims(id),
      type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
  console.log('[db] tables initialized');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

async function addEvent({ taskId, claimId = null, type, actor, data = {} }) {
  await pool.query(
    `INSERT INTO events (id, task_id, claim_id, type, actor_type, actor_id, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuid(), taskId, claimId, type, actor.type, actor.id, JSON.stringify(data), nowIso()]
  );
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

app.post('/v1/tasks', async (req, res) => {
  try {
    const parsed = TaskCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const t = parsed.data;
    const id = uuid();
    const createdAt = nowIso();
    const approver = t.approver ?? { type: 'requester', id: t.requester.id };

    await pool.query(
      `INSERT INTO tasks (id, status, title, instructions, tags, payout_amount, payout_currency, requester_type, requester_id, approver_type, approver_id, deadline_at, created_at, updated_at)
       VALUES ($1, 'open', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [id, t.title, t.instructions, JSON.stringify(t.tags), t.payout.amount, t.payout.currency,
       t.requester.type, t.requester.id, approver.type, approver.id, t.deadlineAt ?? null, createdAt, createdAt]
    );

    await addEvent({ taskId: id, type: 'task.created', actor: t.requester, data: { title: t.title } });

    const task = await getTask(id);
    res.status(201).json({ task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v1/tasks', async (req, res) => {
  try {
    const status = req.query.status;
    const result = status
      ? await pool.query('SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC LIMIT 100', [status])
      : await pool.query('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100');

    res.json({ tasks: result.rows.map(hydrateTask) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v1/tasks/:id', async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not_found' });
    res.json({ task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/tasks/:id/claim', async (req, res) => {
  try {
    const taskId = req.params.id;
    const taskRow = await getTaskRaw(taskId);
    if (!taskRow) return res.status(404).json({ error: 'not_found' });
    if (taskRow.status !== 'open') return res.status(409).json({ error: 'task_not_open' });

    const parsed = ClaimCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { agent } = parsed.data;

    // MVP: one active claim per task
    const existing = await pool.query(
      "SELECT * FROM claims WHERE task_id = $1 AND status IN ('claimed','submitted')",
      [taskId]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'already_claimed' });

    const id = uuid();
    const ts = nowIso();
    await pool.query(
      `INSERT INTO claims (id, task_id, status, agent_type, agent_id, claimed_at, created_at, updated_at)
       VALUES ($1, $2, 'claimed', $3, $4, $5, $6, $7)`,
      [id, taskId, agent.type, agent.id, ts, ts, ts]
    );

    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['claimed', ts, taskId]);
    await addEvent({ taskId, claimId: id, type: 'claim.created', actor: agent });

    res.status(201).json({ claim: await getClaim(id), task: await getTask(taskId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/claims/:id/submit', async (req, res) => {
  try {
    const claimId = req.params.id;
    const claimRow = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
    if (claimRow.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const claim = claimRow.rows[0];
    if (claim.status !== 'claimed') return res.status(409).json({ error: 'claim_not_claimed' });

    const parsed = Submit.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const ts = nowIso();
    await pool.query(
      `UPDATE claims SET status='submitted', submission_kind=$1, submission_payload=$2, submitted_at=$3, updated_at=$4 WHERE id=$5`,
      [parsed.data.kind, JSON.stringify(parsed.data.payload), ts, ts, claimId]
    );

    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['submitted', ts, claim.task_id]);
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.submitted', actor: { type: claim.agent_type, id: claim.agent_id } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/claims/:id/approve', async (req, res) => {
  try {
    const claimId = req.params.id;
    const claimRow = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
    if (claimRow.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const claim = claimRow.rows[0];
    if (claim.status !== 'submitted') return res.status(409).json({ error: 'claim_not_submitted' });

    const ts = nowIso();
    await pool.query(`UPDATE claims SET status='approved', approved_at=$1, updated_at=$2 WHERE id=$3`, [ts, ts, claimId]);
    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['approved', ts, claim.task_id]);
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.approved', actor: { type: 'approver', id: 'manual' } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/v1/claims/:id/reject', async (req, res) => {
  try {
    const claimId = req.params.id;
    const claimRow = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
    if (claimRow.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const claim = claimRow.rows[0];
    if (claim.status !== 'submitted') return res.status(409).json({ error: 'claim_not_submitted' });

    const ts = nowIso();
    await pool.query(`UPDATE claims SET status='rejected', updated_at=$1 WHERE id=$2`, [ts, claimId]);
    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['rejected', ts, claim.task_id]);
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.rejected', actor: { type: 'approver', id: 'manual' } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v1/tasks/:id/events', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE task_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json({
      events: result.rows.map(e => ({
        id: e.id,
        taskId: e.task_id,
        claimId: e.claim_id,
        type: e.type,
        actor: { type: e.actor_type, id: e.actor_id },
        data: e.data,
        createdAt: e.created_at
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

function hydrateTask(row) {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    instructions: row.instructions,
    tags: row.tags,
    payout: { amount: row.payout_amount, currency: row.payout_currency },
    requester: { type: row.requester_type, id: row.requester_id },
    approver: { type: row.approver_type, id: row.approver_id },
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getTaskRaw(id) {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

async function getTask(id) {
  const row = await getTaskRaw(id);
  return row ? hydrateTask(row) : null;
}

async function getClaim(id) {
  const result = await pool.query('SELECT * FROM claims WHERE id = $1', [id]);
  const c = result.rows[0];
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
    submission: c.submission_kind ? { kind: c.submission_kind, payload: c.submission_payload, hash: c.submission_hash } : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

// Start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[clawed-escrow] listening on :${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

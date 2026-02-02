import express from 'express';
import { z } from 'zod';
import pg from 'pg';
import { ethers } from 'ethers';

const { Pool } = pg;

const PORT = process.env.PORT || 8787;
const DATABASE_URL = process.env.DATABASE_URL;
const FEE_BPS = parseInt(process.env.FEE_BPS || '200'); // 2% default
const HD_MNEMONIC = process.env.HD_MNEMONIC;
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_ADDRESS = process.env.USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FUNDING_CONFIRMATIONS = parseInt(process.env.FUNDING_CONFIRMATIONS || '6');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Base provider for funding checks
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

// USDC ABI (just Transfer event)
const USDC_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

// HD Wallet for deposit address derivation
let hdWallet = null;
if (HD_MNEMONIC) {
  hdWallet = ethers.HDNodeWallet.fromPhrase(HD_MNEMONIC);
  console.log('[wallet] HD wallet initialized');
}

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
      fee_amount TEXT,
      required_amount TEXT,
      requester_type TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      approver_type TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      deposit_index INTEGER,
      deposit_address TEXT,
      funded_tx_hash TEXT,
      funded_at TIMESTAMPTZ,
      funded_amount TEXT,
      deadline_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      status TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      submission_kind TEXT,
      submission_payload JSONB,
      submission_hash TEXT,
      claimed_at TIMESTAMPTZ NOT NULL,
      submitted_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      paid_tx_hash TEXT,
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

    CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0,
      tasks_created INTEGER NOT NULL DEFAULT 0,
      tasks_funded INTEGER NOT NULL DEFAULT 0,
      claims_made INTEGER NOT NULL DEFAULT 0,
      claims_approved INTEGER NOT NULL DEFAULT 0,
      claims_rejected INTEGER NOT NULL DEFAULT 0,
      total_earned_usdc TEXT NOT NULL DEFAULT '0',
      total_paid_usdc TEXT NOT NULL DEFAULT '0',
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS aliases (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES wallets(address),
      alias_type TEXT NOT NULL,
      alias_id TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT false,
      proof JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE(alias_type, alias_id)
    );

    CREATE TABLE IF NOT EXISTS deposit_counter (
      id INTEGER PRIMARY KEY DEFAULT 1,
      next_index INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO deposit_counter (id, next_index) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  `);
  console.log('[db] tables initialized');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS for Vercel frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

// Get next deposit index (atomic)
async function getNextDepositIndex() {
  const result = await pool.query(
    'UPDATE deposit_counter SET next_index = next_index + 1 WHERE id = 1 RETURNING next_index - 1 as index'
  );
  return result.rows[0].index;
}

// Derive deposit address from index
function deriveDepositAddress(index) {
  if (!hdWallet) return null;
  const child = hdWallet.derivePath(`m/44'/60'/0'/0/${index}`);
  return child.address;
}

// Calculate fee and required amount
function calculateAmounts(payoutAmount) {
  const payout = parseFloat(payoutAmount);
  const fee = (payout * FEE_BPS) / 10000;
  const required = payout + fee;
  return {
    fee: fee.toFixed(6),
    required: required.toFixed(6),
  };
}

// Ensure wallet exists in reputation table
async function ensureWallet(address) {
  const normalized = address.toLowerCase();
  const existing = await pool.query('SELECT * FROM wallets WHERE address = $1', [normalized]);
  if (existing.rows.length === 0) {
    const ts = nowIso();
    await pool.query(
      'INSERT INTO wallets (address, created_at, updated_at) VALUES ($1, $2, $3)',
      [normalized, ts, ts]
    );
  }
  return normalized;
}

// Update wallet reputation
async function updateWalletRep(address, field, delta = 1) {
  const normalized = address.toLowerCase();
  await ensureWallet(normalized);
  await pool.query(
    `UPDATE wallets SET ${field} = ${field} + $1, updated_at = $2 WHERE address = $3`,
    [delta, nowIso(), normalized]
  );
}

async function addEvent({ taskId, claimId = null, type, actor, data = {} }) {
  await pool.query(
    `INSERT INTO events (id, task_id, claim_id, type, actor_type, actor_id, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuid(), taskId, claimId, type, actor.type, actor.id, JSON.stringify(data), nowIso()]
  );
}

// Admin auth middleware
function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(500).json({ error: 'admin_not_configured' });
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
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
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  agent: z.object({ type: z.string(), id: z.string() }).optional()
});

const Submit = z.object({
  kind: z.enum(['text', 'url', 'json']),
  payload: z.any()
});

// --- Routes
app.get('/health', (req, res) => res.json({ 
  ok: true, 
  now: nowIso(),
  hdWallet: !!hdWallet,
  feeBps: FEE_BPS,
}));

// Create task (status = 'draft' until funded)
app.post('/v1/tasks', async (req, res) => {
  try {
    const parsed = TaskCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const t = parsed.data;
    const id = uuid();
    const createdAt = nowIso();
    const approver = t.approver ?? { type: 'requester', id: t.requester.id };

    // Calculate amounts
    const { fee, required } = calculateAmounts(t.payout.amount);

    // Get deposit address
    let depositIndex = null;
    let depositAddress = null;
    if (hdWallet) {
      depositIndex = await getNextDepositIndex();
      depositAddress = deriveDepositAddress(depositIndex);
    }

    // Ensure requester wallet is tracked
    if (t.requester.type === 'wallet') {
      await ensureWallet(t.requester.id);
      await updateWalletRep(t.requester.id, 'tasks_created');
    }

    // Start as 'draft' (needs funding) or 'open' if no HD wallet configured
    const initialStatus = hdWallet ? 'draft' : 'open';

    await pool.query(
      `INSERT INTO tasks (id, status, title, instructions, tags, payout_amount, payout_currency, fee_amount, required_amount, requester_type, requester_id, approver_type, approver_id, deposit_index, deposit_address, deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [id, initialStatus, t.title, t.instructions, JSON.stringify(t.tags), t.payout.amount, t.payout.currency,
       fee, required, t.requester.type, t.requester.id, approver.type, approver.id, 
       depositIndex, depositAddress, t.deadlineAt ?? null, createdAt, createdAt]
    );

    await addEvent({ taskId: id, type: 'task.created', actor: t.requester, data: { title: t.title } });

    const task = await getTask(id);
    res.status(201).json({ task });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// List tasks
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

// Get task
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

// Check/refresh funding status
app.post('/v1/tasks/:id/check-funding', async (req, res) => {
  try {
    const taskId = req.params.id;
    const taskRow = await getTaskRaw(taskId);
    if (!taskRow) return res.status(404).json({ error: 'not_found' });
    if (taskRow.status !== 'draft') {
      return res.json({ task: hydrateTask(taskRow), funded: taskRow.status !== 'draft' });
    }
    if (!taskRow.deposit_address) {
      return res.status(400).json({ error: 'no_deposit_address' });
    }

    // Check USDC transfers to deposit address on Base
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const filter = usdc.filters.Transfer(null, taskRow.deposit_address);
    
    // Look back ~1000 blocks (~30 min on Base)
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 1000);
    
    const events = await usdc.queryFilter(filter, fromBlock, currentBlock);
    
    // Find a transfer with enough value
    const requiredWei = ethers.parseUnits(taskRow.required_amount, 6); // USDC has 6 decimals
    
    for (const event of events) {
      if (event.args.value >= requiredWei) {
        const receipt = await event.getTransactionReceipt();
        const confirmations = currentBlock - receipt.blockNumber;
        
        if (confirmations >= FUNDING_CONFIRMATIONS) {
          // Mark as funded!
          const ts = nowIso();
          const fundedAmount = ethers.formatUnits(event.args.value, 6);
          
          await pool.query(
            `UPDATE tasks SET status = 'open', funded_tx_hash = $1, funded_at = $2, funded_amount = $3, updated_at = $4 WHERE id = $5`,
            [event.transactionHash, ts, fundedAmount, ts, taskId]
          );
          
          if (taskRow.requester_type === 'wallet') {
            await updateWalletRep(taskRow.requester_id, 'tasks_funded');
          }
          
          await addEvent({ 
            taskId, 
            type: 'task.funded', 
            actor: { type: 'system', id: 'funding-checker' },
            data: { txHash: event.transactionHash, amount: fundedAmount }
          });
          
          const task = await getTask(taskId);
          return res.json({ task, funded: true, txHash: event.transactionHash });
        }
      }
    }
    
    res.json({ task: hydrateTask(taskRow), funded: false, message: 'No confirmed funding found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', details: err.message });
  }
});

// Admin: manually mark as funded (for testing)
app.post('/v1/tasks/:id/fund', adminAuth, async (req, res) => {
  try {
    const taskId = req.params.id;
    const taskRow = await getTaskRaw(taskId);
    if (!taskRow) return res.status(404).json({ error: 'not_found' });
    
    const ts = nowIso();
    await pool.query(
      `UPDATE tasks SET status = 'open', funded_at = $1, funded_amount = $2, updated_at = $3 WHERE id = $4`,
      [ts, taskRow.required_amount, ts, taskId]
    );
    
    await addEvent({ 
      taskId, 
      type: 'task.funded', 
      actor: { type: 'admin', id: 'manual' },
      data: { manual: true }
    });
    
    const task = await getTask(taskId);
    res.json({ task, funded: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Claim task (requires wallet, task must be open/funded)
app.post('/v1/tasks/:id/claim', async (req, res) => {
  try {
    const taskId = req.params.id;
    const taskRow = await getTaskRaw(taskId);
    if (!taskRow) return res.status(404).json({ error: 'not_found' });
    if (taskRow.status === 'draft') return res.status(409).json({ error: 'task_not_funded' });
    if (taskRow.status !== 'open') return res.status(409).json({ error: 'task_not_open' });

    const parsed = ClaimCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    
    const { wallet, agent } = parsed.data;
    const agentInfo = agent ?? { type: 'wallet', id: wallet };

    // Ensure wallet is tracked
    await ensureWallet(wallet);

    // MVP: one active claim per task
    const existing = await pool.query(
      "SELECT * FROM claims WHERE task_id = $1 AND status IN ('claimed','submitted')",
      [taskId]
    );
    if (existing.rows.length > 0) return res.status(409).json({ error: 'already_claimed' });

    const id = uuid();
    const ts = nowIso();
    await pool.query(
      `INSERT INTO claims (id, task_id, status, wallet_address, agent_type, agent_id, claimed_at, created_at, updated_at)
       VALUES ($1, $2, 'claimed', $3, $4, $5, $6, $7, $8)`,
      [id, taskId, wallet.toLowerCase(), agentInfo.type, agentInfo.id, ts, ts, ts]
    );

    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['claimed', ts, taskId]);
    await updateWalletRep(wallet, 'claims_made');
    await addEvent({ taskId, claimId: id, type: 'claim.created', actor: agentInfo });

    res.status(201).json({ claim: await getClaim(id), task: await getTask(taskId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Submit proof
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

// Approve claim
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
    
    await updateWalletRep(claim.wallet_address, 'claims_approved');
    await updateWalletRep(claim.wallet_address, 'score', 1);
    
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.approved', actor: { type: 'approver', id: 'manual' } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Reject claim
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
    
    await updateWalletRep(claim.wallet_address, 'claims_rejected');
    await updateWalletRep(claim.wallet_address, 'score', -2);
    
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.rejected', actor: { type: 'approver', id: 'manual' } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Get task events
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

// Get wallet reputation
app.get('/v1/wallets/:address/reputation', async (req, res) => {
  try {
    const address = req.params.address.toLowerCase();
    const result = await pool.query('SELECT * FROM wallets WHERE address = $1', [address]);
    if (result.rows.length === 0) {
      return res.json({ wallet: address, reputation: null });
    }
    
    const w = result.rows[0];
    const aliases = await pool.query('SELECT alias_type, alias_id, verified FROM aliases WHERE wallet_address = $1', [address]);
    
    res.json({
      wallet: address,
      reputation: {
        score: w.score,
        stats: {
          tasksCreated: w.tasks_created,
          tasksFunded: w.tasks_funded,
          claimsMade: w.claims_made,
          claimsApproved: w.claims_approved,
          claimsRejected: w.claims_rejected,
          totalEarnedUsdc: w.total_earned_usdc,
          totalPaidUsdc: w.total_paid_usdc,
        },
        aliases: aliases.rows.map(a => ({ type: a.alias_type, id: a.alias_id, verified: a.verified })),
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Leaderboard
app.get('/v1/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT address, score, claims_approved, total_earned_usdc FROM wallets ORDER BY score DESC LIMIT 50'
    );
    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Get claims for a task
app.get('/v1/tasks/:id/claims', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM claims WHERE task_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ claims: result.rows.map(hydrateClaim) });
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
    fee: row.fee_amount,
    requiredAmount: row.required_amount,
    requester: { type: row.requester_type, id: row.requester_id },
    approver: { type: row.approver_type, id: row.approver_id },
    deposit: row.deposit_address ? {
      address: row.deposit_address,
      index: row.deposit_index,
    } : null,
    funding: row.funded_at ? {
      txHash: row.funded_tx_hash,
      amount: row.funded_amount,
      at: row.funded_at,
    } : null,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateClaim(c) {
  return {
    id: c.id,
    taskId: c.task_id,
    status: c.status,
    wallet: c.wallet_address,
    agent: { type: c.agent_type, id: c.agent_id },
    claimedAt: c.claimed_at,
    submittedAt: c.submitted_at,
    approvedAt: c.approved_at,
    paidAt: c.paid_at,
    paidTxHash: c.paid_tx_hash,
    submission: c.submission_kind ? { kind: c.submission_kind, payload: c.submission_payload, hash: c.submission_hash } : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at
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
  return hydrateClaim(c);
}

// Start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`[clawed-escrow] listening on :${PORT}`);
    console.log(`[config] FEE_BPS=${FEE_BPS}, FUNDING_CONFIRMATIONS=${FUNDING_CONFIRMATIONS}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

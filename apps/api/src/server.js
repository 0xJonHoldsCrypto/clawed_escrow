import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import pg from 'pg';
import { ethers } from 'ethers';
import crypto from 'crypto';

// Onchain (v2)
import { ESCROW_CONTRACT_ADDRESS, escrow as escrowContract, provider as baseProvider, wsProvider } from './contract.js';
import { indexOnce, ensureCursorRow, getCursor, processEscrowLog, TOPICS } from './indexer.js';

const { Pool } = pg;

const PORT = process.env.PORT || 8787;
const DATABASE_URL = process.env.DATABASE_URL;
const FEE_BPS = parseInt(process.env.FEE_BPS || '200');
const HD_MNEMONIC = process.env.HD_MNEMONIC;
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_ADDRESS = process.env.USDC_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FUNDING_CONFIRMATIONS = parseInt(process.env.FUNDING_CONFIRMATIONS || '6');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // For AI judge
const MIN_REP_HIGH_VALUE = parseInt(process.env.MIN_REP_HIGH_VALUE || '5'); // Min rep for tasks > 10 USDC
const HIGH_VALUE_THRESHOLD = parseFloat(process.env.HIGH_VALUE_THRESHOLD || '10');

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const USDC_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

// v2 indexer settings
const INDEXER_CONFIRMATIONS = parseInt(process.env.INDEXER_CONFIRMATIONS || '15');
const INDEXER_BATCH_BLOCKS = parseInt(process.env.INDEXER_BATCH_BLOCKS || '1500');

let hdWallet = null;
if (HD_MNEMONIC) {
  hdWallet = ethers.HDNodeWallet.fromPhrase(HD_MNEMONIC);
  console.log('[wallet] HD wallet initialized');
}

// ============ SECURITY: Rate Limiting ============
const rateLimits = new Map(); // IP -> { count, resetAt }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // 100 requests per minute

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  let record = rateLimits.get(ip);
  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimits.set(ip, record);
  }
  
  record.count++;
  
  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'rate_limit_exceeded', retryAfter: Math.ceil((record.resetAt - now) / 1000) });
  }
  
  next();
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits.entries()) {
    if (now > record.resetAt) rateLimits.delete(ip);
  }
}, 60000);

// ============ SECURITY: Nonce Replay Protection ============
const usedNonces = new Map(); // nonce -> expiresAt
const NONCE_WINDOW = 5 * 60 * 1000; // 5 minutes

function isNonceUsed(nonce) {
  const record = usedNonces.get(nonce);
  if (!record) return false;
  if (Date.now() > record) {
    usedNonces.delete(nonce);
    return false;
  }
  return true;
}

function markNonceUsed(nonce) {
  usedNonces.set(nonce, Date.now() + NONCE_WINDOW);
}

// Clean up old nonces
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expires] of usedNonces.entries()) {
    if (now > expires) usedNonces.delete(nonce);
  }
}, 60000);

// ============ SECURITY: Wallet Signature Auth ============
const SIGNATURE_WINDOW = 120 * 1000; // 2 minutes

function buildSignMessage({ method, path, timestamp, nonce, bodyHash }) {
  return `ClawedEscrow\n${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

async function walletAuth(req, res, next) {
  const wallet = req.headers['x-wallet-address'];
  const signature = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];
  const nonce = req.headers['x-nonce'];
  
  // Allow unauthenticated for read-only endpoints
  if (!wallet && !signature) {
    req.wallet = null;
    return next();
  }
  
  if (!wallet || !signature || !timestamp || !nonce) {
    return res.status(401).json({ error: 'missing_auth_headers', required: ['x-wallet-address', 'x-signature', 'x-timestamp', 'x-nonce'] });
  }
  
  // Validate wallet address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(401).json({ error: 'invalid_wallet_address' });
  }
  
  // Check timestamp is within window
  const ts = parseInt(timestamp);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > SIGNATURE_WINDOW) {
    return res.status(401).json({ error: 'timestamp_expired', message: 'Timestamp must be within 2 minutes' });
  }
  
  // Check nonce hasn't been used
  if (isNonceUsed(nonce)) {
    return res.status(401).json({ error: 'nonce_already_used' });
  }
  
  // Build message and verify signature
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(req.body) || '').digest('hex');
  const message = buildSignMessage({
    method: req.method,
    path: req.path,
    timestamp,
    nonce,
    bodyHash,
  });
  
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return res.status(401).json({ error: 'signature_mismatch' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  
  // Mark nonce as used
  markNonceUsed(nonce);
  
  // Attach wallet to request
  req.wallet = wallet.toLowerCase();
  next();
}

// Require authenticated wallet
function requireAuth(req, res, next) {
  if (!req.wallet) {
    return res.status(401).json({ error: 'authentication_required', message: 'This endpoint requires wallet signature authentication' });
  }
  next();
}

// ============ Database Init ============
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
      verification_type TEXT NOT NULL DEFAULT 'manual',
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
      ai_verification_result JSONB,
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
      is_trusted_requester BOOLEAN NOT NULL DEFAULT false,
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

    -- ===== v2 onchain projection tables =====
    CREATE TABLE IF NOT EXISTS escrow_events (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      event_name TEXT NOT NULL,
      task_id TEXT,
      args JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, contract_address, tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS escrow_tasks (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      task_id TEXT NOT NULL,
      requester TEXT,
      deadline BIGINT,
      review_window BIGINT,
      escalation_window BIGINT,
      max_winners INTEGER,
      approved_count INTEGER,
      withdrawn_count INTEGER,
      pending_submissions INTEGER,
      payout_amount TEXT,
      deposit_fee_amount TEXT,
      recipient_fee_amount TEXT,
      status INTEGER,
      spec_hash TEXT,
      balance TEXT,
      submission_count INTEGER,
      claim_count INTEGER,
      created_block INTEGER,
      created_tx TEXT,
      updated_block INTEGER,
      updated_tx TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, contract_address, task_id)
    );

    CREATE TABLE IF NOT EXISTS escrow_indexer_cursor (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      last_processed_block INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, contract_address)
    );

    CREATE TABLE IF NOT EXISTS escrow_submissions (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      task_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      agent TEXT,
      status INTEGER,
      submitted_at BIGINT,
      proof_hash TEXT,
      created_block INTEGER,
      created_tx TEXT,
      updated_block INTEGER,
      updated_tx TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, contract_address, task_id, submission_id)
    );

    CREATE TABLE IF NOT EXISTS escrow_submission_proofs (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      task_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      proof_text TEXT NOT NULL,
      proof_hash TEXT NOT NULL,
      tx_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS escrow_task_metadata (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      task_id TEXT NOT NULL,
      spec_hash TEXT,
      title TEXT,
      instructions TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, contract_address, task_id)
    );

    CREATE INDEX IF NOT EXISTS escrow_submission_proofs_lookup
      ON escrow_submission_proofs (chain_id, contract_address, task_id, submission_id, created_at DESC);

    -- cursor row is initialized in JS (after initDb) once env is available

    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='verification_type') THEN
        ALTER TABLE tasks ADD COLUMN verification_type TEXT NOT NULL DEFAULT 'manual';
      END IF;
    END $$;
    
    -- Add ai_verification_result column if missing
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='claims' AND column_name='ai_verification_result') THEN
        ALTER TABLE claims ADD COLUMN ai_verification_result JSONB;
      END IF;
    END $$;
    
    -- Add is_trusted_requester column if missing
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wallets' AND column_name='is_trusted_requester') THEN
        ALTER TABLE wallets ADD COLUMN is_trusted_requester BOOLEAN NOT NULL DEFAULT false;
      END IF;
    END $$;
  `);
  console.log('[db] tables initialized');
  await ensureCursorRow(pool);
}

// ============ v2 indexer loop (best-effort) ============
let indexerState = { last: null, error: null };
async function startIndexer() {
  // Backfill loop (HTTP getLogs)
  const runOnce = async () => {
    try {
      indexerState.last = await indexOnce({ pool, confirmations: INDEXER_CONFIRMATIONS, batchBlocks: INDEXER_BATCH_BLOCKS });
      indexerState.error = null;
    } catch (e) {
      indexerState.error = String(e?.message || e);
    }
  };

  await runOnce();
  setInterval(runOnce, 10_000);

  // Tail via websocket (optional) for near-instant UX
  if (wsProvider) {
    try {
      const filter = { address: ESCROW_CONTRACT_ADDRESS, topics: [TOPICS] };
      wsProvider.on(filter, async (log) => {
        try {
          // ethers ws log shape is compatible with Interface.parseLog
          await processEscrowLog({ pool, log });
        } catch (e) {
          // don't kill the ws stream
          indexerState.error = String(e?.message || e);
        }
      });
      console.log('[v2] ws tailing enabled');
    } catch (e) {
      console.error('[v2] ws tailing failed to start', e);
    }
  }
}

const app = express();

// Behind Railway/Reverse proxies, req.ip should reflect X-Forwarded-For.
// trust proxy=1 is a common safe default (single hop) and improves rate limiting.
app.set('trust proxy', 1);

// Basic hardening headers (API only; keep CSP off)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key, X-Wallet-Address, X-Signature, X-Timestamp, X-Nonce');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Apply rate limiting and auth to all routes
app.use(rateLimit);
app.use(walletAuth);

// ============ Helpers ============
function nowIso() { return new Date().toISOString(); }
function uuid() { return crypto.randomUUID(); }

async function getNextDepositIndex() {
  const result = await pool.query(
    'UPDATE deposit_counter SET next_index = next_index + 1 WHERE id = 1 RETURNING next_index - 1 as index'
  );
  return result.rows[0].index;
}

function deriveDepositAddress(index) {
  if (!hdWallet) return null;
  const child = hdWallet.derivePath(`m/44'/60'/0'/0/${index}`);
  return child.address;
}

function calculateAmounts(payoutAmount) {
  const payout = parseFloat(payoutAmount);
  const fee = (payout * FEE_BPS) / 10000;
  const required = payout + fee;
  return { fee: fee.toFixed(6), required: required.toFixed(6) };
}

async function ensureWallet(address) {
  const normalized = address.toLowerCase();
  const existing = await pool.query('SELECT * FROM wallets WHERE address = $1', [normalized]);
  if (existing.rows.length === 0) {
    const ts = nowIso();
    await pool.query('INSERT INTO wallets (address, created_at, updated_at) VALUES ($1, $2, $3)', [normalized, ts, ts]);
  }
  return normalized;
}

async function getWalletRep(address) {
  const normalized = address.toLowerCase();
  const result = await pool.query('SELECT * FROM wallets WHERE address = $1', [normalized]);
  return result.rows[0] || null;
}

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

// ============ AI Judge Verification ============
async function aiJudgeVerify(task, claim) {
  if (!OPENAI_API_KEY) {
    return { approved: false, reason: 'AI judge not configured', confidence: 0 };
  }
  
  const prompt = `You are an escrow verification judge. Review this task submission and determine if it meets the requirements.

TASK TITLE: ${task.title}

TASK INSTRUCTIONS:
${task.instructions}

SUBMISSION TYPE: ${claim.submission_kind}
SUBMISSION CONTENT:
${JSON.stringify(claim.submission_payload, null, 2)}

Based on the task requirements, does this submission adequately complete the task?

Respond in JSON format:
{
  "approved": true/false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation"
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
      }),
    });
    
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        approved: result.approved === true,
        confidence: Math.min(1, Math.max(0, result.confidence || 0)),
        reason: result.reason || 'No reason provided',
      };
    }
    
    return { approved: false, reason: 'Failed to parse AI response', confidence: 0 };
  } catch (err) {
    console.error('[ai_judge] Error:', err);
    return { approved: false, reason: `AI judge error: ${err.message}`, confidence: 0 };
  }
}

// Admin auth middleware
function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(500).json({ error: 'admin_not_configured' });
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ============ Schemas ============
const TaskCreate = z.object({
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20000),
  tags: z.array(z.string()).default([]),
  payout: z.object({
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    currency: z.literal('USDC_BASE')
  }),
  verificationType: z.enum(['manual', 'ai_judge']).default('manual'),
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

const V2ProofSave = z.object({
  proofText: z.string().min(1).max(20000),
  proofHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
});

const V2TaskMetadataSave = z.object({
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20000),
  specHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

// ============ Routes ============

// ===== v2 (onchain) =====
app.get('/v2/escrow', async (req, res) => {
  try {
    const [usdc, treasury, arbiter] = await Promise.all([
      escrowContract.usdc(),
      escrowContract.treasury(),
      escrowContract.arbiter(),
    ]);

    res.json({
      chainId: 8453,
      contractAddress: ESCROW_CONTRACT_ADDRESS,
      usdc,
      treasury,
      arbiter,
      creatorFeeBps: 200,
      recipientFeeBps: 200,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v2/indexer/status', async (req, res) => {
  try {
    const head = await baseProvider.getBlockNumber();
    const cursor = await getCursor(pool);
    res.json({ chainId: 8453, contractAddress: ESCROW_CONTRACT_ADDRESS, head, cursor, last: indexerState.last, error: indexerState.error });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v2/tasks', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.*, m.title, m.instructions
       FROM escrow_tasks t
       LEFT JOIN escrow_task_metadata m
         ON m.chain_id=t.chain_id AND m.contract_address=t.contract_address AND m.task_id=t.task_id
       WHERE t.chain_id=8453 AND t.contract_address=$1
       ORDER BY COALESCE(t.updated_block, t.created_block) DESC NULLS LAST
       LIMIT 200`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase()]
    );
    res.json({ tasks: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v2/tasks/:id', async (req, res) => {
  try {
    const taskId = req.params.id;
    const r = await pool.query(
      `SELECT t.*, m.title, m.instructions
       FROM escrow_tasks t
       LEFT JOIN escrow_task_metadata m
         ON m.chain_id=t.chain_id AND m.contract_address=t.contract_address AND m.task_id=t.task_id
       WHERE t.chain_id=8453 AND t.contract_address=$1 AND t.task_id=$2
       LIMIT 1`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId]
    );
    const task = r.rows[0] || null;
    if (!task) return res.status(404).json({ error: 'task_not_found' });
    res.json({ task });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Save offchain title/instructions (so the UI can display human-readable specs).
// Auth required; wallet must match onchain requester; specHash must match indexer row.
app.post('/v2/tasks/:id/metadata', requireAuth, async (req, res) => {
  try {
    const taskId = req.params.id;
    const parsed = V2TaskMetadataSave.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const t = await pool.query(
      `SELECT requester, spec_hash FROM escrow_tasks WHERE chain_id=8453 AND contract_address=$1 AND task_id=$2 LIMIT 1`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId]
    );
    if (t.rows.length === 0) return res.status(404).json({ error: 'task_not_found' });

    const requester = String(t.rows[0].requester || '').toLowerCase();
    const specHash = String(t.rows[0].spec_hash || '').toLowerCase();

    if (!requester || requester !== req.wallet) {
      return res.status(403).json({ error: 'not_requester', message: 'Only the onchain requester can set metadata.' });
    }

    if (specHash && specHash !== parsed.data.specHash.toLowerCase()) {
      return res.status(409).json({ error: 'spec_hash_mismatch', onchain: specHash, provided: parsed.data.specHash.toLowerCase() });
    }

    await pool.query(
      `INSERT INTO escrow_task_metadata (chain_id, contract_address, task_id, spec_hash, title, instructions, created_by, created_at, updated_at)
       VALUES (8453, $1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (chain_id, contract_address, task_id)
       DO UPDATE SET spec_hash=EXCLUDED.spec_hash, title=EXCLUDED.title, instructions=EXCLUDED.instructions, updated_at=NOW()`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, parsed.data.specHash.toLowerCase(), parsed.data.title, parsed.data.instructions, req.wallet]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v2/tasks/:id/submissions', async (req, res) => {
  try {
    const taskId = req.params.id;
    const viewer = req.wallet ? String(req.wallet).toLowerCase() : null;

    // Only show proof_text to the requester or the submitting agent.
    const r = await pool.query(
      `SELECT 
        s.*,
        CASE
          WHEN $3::text IS NOT NULL AND (
            LOWER(s.agent) = $3 OR LOWER(t.requester) = $3
          ) THEN p.proof_text
          ELSE NULL
        END AS proof_text
       FROM escrow_submissions s
       LEFT JOIN escrow_tasks t
         ON t.chain_id=s.chain_id AND t.contract_address=s.contract_address AND t.task_id=s.task_id
       LEFT JOIN LATERAL (
         SELECT proof_text
         FROM escrow_submission_proofs p
         WHERE p.chain_id=s.chain_id AND p.contract_address=s.contract_address AND p.task_id=s.task_id AND p.submission_id=s.submission_id
         ORDER BY p.created_at DESC
         LIMIT 1
       ) p ON TRUE
       WHERE s.chain_id=8453 AND s.contract_address=$1 AND s.task_id=$2
       ORDER BY CAST(s.submission_id AS BIGINT) ASC
       LIMIT 500`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, viewer]
    );

    res.json({ submissions: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Save offchain proof text for a submission (so requesters can see it).
// Auth required; wallet must match the agent that claimed the submission.
app.post('/v2/tasks/:id/submissions/:submissionId/proof', requireAuth, async (req, res) => {
  try {
    const taskId = req.params.id;
    const submissionId = req.params.submissionId;

    const parsed = V2ProofSave.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // must match agent wallet
    const s = await pool.query(
      `SELECT agent, proof_hash FROM escrow_submissions WHERE chain_id=8453 AND contract_address=$1 AND task_id=$2 AND submission_id=$3`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId]
    );
    if (s.rows.length === 0) return res.status(404).json({ error: 'submission_not_found' });

    const agent = (s.rows[0].agent || '').toLowerCase();
    if (!agent || agent !== req.wallet) {
      return res.status(403).json({ error: 'not_agent', message: 'Only the claiming agent can attach proof text.' });
    }

    // Ensure proofHash matches what indexer saw onchain (best-effort)
    const onchainHash = s.rows[0].proof_hash;
    if (onchainHash && String(onchainHash).toLowerCase() !== parsed.data.proofHash.toLowerCase()) {
      return res.status(409).json({ error: 'proof_hash_mismatch', onchain: onchainHash, provided: parsed.data.proofHash });
    }

    await pool.query(
      `INSERT INTO escrow_submission_proofs (chain_id, contract_address, task_id, submission_id, wallet, proof_text, proof_hash, tx_hash)
       VALUES (8453, $1, $2, $3, $4, $5, $6, $7)`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId, req.wallet, parsed.data.proofText, parsed.data.proofHash, parsed.data.txHash ?? null]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/v2/tasks/:id/events', async (req, res) => {
  try {
    const taskId = req.params.id;
    const r = await pool.query(
      `SELECT * FROM escrow_events WHERE chain_id=8453 AND contract_address=$1 AND task_id=$2 ORDER BY block_number ASC, log_index ASC LIMIT 500`,
      [ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId]
    );
    res.json({ events: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Debug: quick counts for v2 tables (safe: no secrets)
app.get('/v2/debug/counts', async (req, res) => {
  try {
    const [ev, tasks, cur] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM escrow_events WHERE chain_id=8453 AND contract_address=$1`, [ESCROW_CONTRACT_ADDRESS.toLowerCase()]),
      pool.query(`SELECT COUNT(*)::int AS n FROM escrow_tasks WHERE chain_id=8453 AND contract_address=$1`, [ESCROW_CONTRACT_ADDRESS.toLowerCase()]),
      pool.query(`SELECT last_processed_block FROM escrow_indexer_cursor WHERE chain_id=8453 AND contract_address=$1`, [ESCROW_CONTRACT_ADDRESS.toLowerCase()]),
    ]);

    res.json({
      chainId: 8453,
      contractAddress: ESCROW_CONTRACT_ADDRESS.toLowerCase(),
      escrowEvents: ev.rows[0]?.n ?? 0,
      escrowTasks: tasks.rows[0]?.n ?? 0,
      cursor: cur.rows[0]?.last_processed_block ?? null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});


app.get('/health', async (req, res) => {
  const head = await baseProvider.getBlockNumber().catch(() => null);
  const cursor = await getCursor(pool).catch(() => null);
  res.json({
    ok: true,
    now: nowIso(),
    hdWallet: !!hdWallet,
    aiJudge: !!OPENAI_API_KEY,
    feeBps: FEE_BPS,
    minRepHighValue: MIN_REP_HIGH_VALUE,
    highValueThreshold: HIGH_VALUE_THRESHOLD,
    v2: {
      chainId: 8453,
      escrowContract: ESCROW_CONTRACT_ADDRESS,
      indexer: { head, cursor, last: indexerState.last, error: indexerState.error },
    },
  });
});

// Auth info endpoint
app.get('/v1/auth/info', (req, res) => {
  res.json({
    authenticated: !!req.wallet,
    wallet: req.wallet,
    signatureFormat: {
      message: 'ClawedEscrow\\n{method}\\n{path}\\n{timestamp}\\n{nonce}\\n{bodyHash}',
      headers: ['X-Wallet-Address', 'X-Signature', 'X-Timestamp', 'X-Nonce'],
      bodyHash: 'SHA256 of JSON body',
      timestampWindow: '120 seconds',
    }
  });
});

// Create task
app.post('/v1/tasks', requireAuth, async (req, res) => {
  try {
    const parsed = TaskCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const t = parsed.data;
    
    // Requester must match authenticated wallet
    if (t.requester.type === 'wallet' && t.requester.id.toLowerCase() !== req.wallet) {
      return res.status(403).json({ error: 'requester_wallet_mismatch', message: 'Requester wallet must match authenticated wallet' });
    }
    
    const id = uuid();
    const createdAt = nowIso();
    const approver = t.approver ?? { type: 'wallet', id: req.wallet };
    const { fee, required } = calculateAmounts(t.payout.amount);

    let depositIndex = null;
    let depositAddress = null;
    if (hdWallet) {
      depositIndex = await getNextDepositIndex();
      depositAddress = deriveDepositAddress(depositIndex);
    }

    await ensureWallet(req.wallet);
    await updateWalletRep(req.wallet, 'tasks_created');

    const initialStatus = hdWallet ? 'draft' : 'open';

    await pool.query(
      `INSERT INTO tasks (id, status, title, instructions, tags, payout_amount, payout_currency, fee_amount, required_amount, verification_type, requester_type, requester_id, approver_type, approver_id, deposit_index, deposit_address, deadline_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [id, initialStatus, t.title, t.instructions, JSON.stringify(t.tags), t.payout.amount, t.payout.currency,
       fee, required, t.verificationType, t.requester.type, req.wallet, approver.type, approver.id.toLowerCase(), 
       depositIndex, depositAddress, t.deadlineAt ?? null, createdAt, createdAt]
    );

    await addEvent({ taskId: id, type: 'task.created', actor: { type: 'wallet', id: req.wallet }, data: { title: t.title } });

    res.status(201).json({ task: await getTask(id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// List tasks (public)
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

// Get task (public)
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

// Check funding (public)
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

    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const filter = usdc.filters.Transfer(null, taskRow.deposit_address);
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 1000);
    const events = await usdc.queryFilter(filter, fromBlock, currentBlock);
    const requiredWei = ethers.parseUnits(taskRow.required_amount, 6);
    
    for (const event of events) {
      if (event.args.value >= requiredWei) {
        const receipt = await event.getTransactionReceipt();
        const confirmations = currentBlock - receipt.blockNumber;
        
        if (confirmations >= FUNDING_CONFIRMATIONS) {
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
          
          return res.json({ task: await getTask(taskId), funded: true, txHash: event.transactionHash });
        }
      }
    }
    
    res.json({ task: hydrateTask(taskRow), funded: false, message: 'No confirmed funding found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error', details: err.message });
  }
});

// Admin fund (testing)
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
    
    await addEvent({ taskId, type: 'task.funded', actor: { type: 'admin', id: 'manual' }, data: { manual: true } });
    
    res.json({ task: await getTask(taskId), funded: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Claim task (requires auth + reputation check)
app.post('/v1/tasks/:id/claim', requireAuth, async (req, res) => {
  try {
    const taskId = req.params.id;
    const taskRow = await getTaskRaw(taskId);
    if (!taskRow) return res.status(404).json({ error: 'not_found' });
    if (taskRow.status === 'draft') return res.status(409).json({ error: 'task_not_funded' });
    if (taskRow.status !== 'open') return res.status(409).json({ error: 'task_not_open' });

    const parsed = ClaimCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    
    const { wallet, agent } = parsed.data;
    
    // Wallet must match authenticated wallet
    if (wallet.toLowerCase() !== req.wallet) {
      return res.status(403).json({ error: 'wallet_mismatch', message: 'Claim wallet must match authenticated wallet' });
    }
    
    const agentInfo = agent ?? { type: 'wallet', id: wallet };

    // Reputation check for high-value tasks
    const payoutAmount = parseFloat(taskRow.payout_amount);
    if (payoutAmount > HIGH_VALUE_THRESHOLD) {
      const walletRep = await getWalletRep(wallet);
      const score = walletRep?.score || 0;
      if (score < MIN_REP_HIGH_VALUE) {
        return res.status(403).json({ 
          error: 'insufficient_reputation',
          message: `Tasks over ${HIGH_VALUE_THRESHOLD} USDC require reputation score of ${MIN_REP_HIGH_VALUE}+. Your score: ${score}`,
          requiredScore: MIN_REP_HIGH_VALUE,
          yourScore: score,
        });
      }
    }

    await ensureWallet(wallet);

    // Check for existing claims
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

// Submit proof (requires auth, must be claimer)
app.post('/v1/claims/:id/submit', requireAuth, async (req, res) => {
  try {
    const claimId = req.params.id;
    const claimRow = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
    if (claimRow.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const claim = claimRow.rows[0];
    
    // Must be the claimer
    if (claim.wallet_address !== req.wallet) {
      return res.status(403).json({ error: 'not_claimer', message: 'Only the claimer can submit proof' });
    }
    
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

    // If AI judge, run verification
    const taskRow = await getTaskRaw(claim.task_id);
    if (taskRow.verification_type === 'ai_judge') {
      const updatedClaim = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
      const aiResult = await aiJudgeVerify(taskRow, updatedClaim.rows[0]);
      
      await pool.query(
        `UPDATE claims SET ai_verification_result = $1, updated_at = $2 WHERE id = $3`,
        [JSON.stringify(aiResult), nowIso(), claimId]
      );
      
      await addEvent({ 
        taskId: claim.task_id, 
        claimId, 
        type: 'claim.ai_verified', 
        actor: { type: 'system', id: 'ai-judge' },
        data: aiResult
      });
      
      // Auto-approve if AI confident enough
      if (aiResult.approved && aiResult.confidence >= 0.8) {
        await pool.query(`UPDATE claims SET status='approved', approved_at=$1, updated_at=$2 WHERE id=$3`, [nowIso(), nowIso(), claimId]);
        await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['approved', nowIso(), claim.task_id]);
        await updateWalletRep(claim.wallet_address, 'claims_approved');
        await updateWalletRep(claim.wallet_address, 'score', 1);
        await addEvent({ taskId: claim.task_id, claimId, type: 'claim.approved', actor: { type: 'system', id: 'ai-judge' } });
      }
    }

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Approve claim (requires auth, must be requester/approver)
app.post('/v1/claims/:id/approve', requireAuth, async (req, res) => {
  try {
    const claimId = req.params.id;
    const claimRow = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
    if (claimRow.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const claim = claimRow.rows[0];
    
    const taskRow = await getTaskRaw(claim.task_id);
    
    // Must be the approver (requester or designated approver)
    if (taskRow.approver_id !== req.wallet && taskRow.requester_id !== req.wallet) {
      return res.status(403).json({ error: 'not_approver', message: 'Only the task requester or designated approver can approve' });
    }
    
    if (claim.status !== 'submitted') return res.status(409).json({ error: 'claim_not_submitted' });

    const ts = nowIso();
    await pool.query(`UPDATE claims SET status='approved', approved_at=$1, updated_at=$2 WHERE id=$3`, [ts, ts, claimId]);
    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['approved', ts, claim.task_id]);
    
    await updateWalletRep(claim.wallet_address, 'claims_approved');
    await updateWalletRep(claim.wallet_address, 'score', 1);
    
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.approved', actor: { type: 'wallet', id: req.wallet } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Reject claim (requires auth, must be requester/approver)
app.post('/v1/claims/:id/reject', requireAuth, async (req, res) => {
  try {
    const claimId = req.params.id;
    const claimRow = await pool.query('SELECT * FROM claims WHERE id = $1', [claimId]);
    if (claimRow.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const claim = claimRow.rows[0];
    
    const taskRow = await getTaskRaw(claim.task_id);
    
    // Must be the approver
    if (taskRow.approver_id !== req.wallet && taskRow.requester_id !== req.wallet) {
      return res.status(403).json({ error: 'not_approver', message: 'Only the task requester or designated approver can reject' });
    }
    
    if (claim.status !== 'submitted') return res.status(409).json({ error: 'claim_not_submitted' });

    const ts = nowIso();
    await pool.query(`UPDATE claims SET status='rejected', updated_at=$1 WHERE id=$2`, [ts, claimId]);
    
    // Re-open the task so others can claim
    await pool.query('UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3', ['open', ts, claim.task_id]);
    
    await updateWalletRep(claim.wallet_address, 'claims_rejected');
    await updateWalletRep(claim.wallet_address, 'score', -2);
    
    await addEvent({ taskId: claim.task_id, claimId, type: 'claim.rejected', actor: { type: 'wallet', id: req.wallet } });

    res.json({ claim: await getClaim(claimId), task: await getTask(claim.task_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Get task events (public)
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

// Get claims for task (public)
app.get('/v1/tasks/:id/claims', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM claims WHERE task_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ claims: result.rows.map(hydrateClaim) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Get wallet reputation (public)
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
        isTrustedRequester: w.is_trusted_requester,
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

// Leaderboard (public)
app.get('/v1/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT address, score, claims_approved, claims_rejected, total_earned_usdc FROM wallets WHERE score > 0 ORDER BY score DESC LIMIT 50'
    );
    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ============ Hydrators ============
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
    verificationType: row.verification_type,
    requester: { type: row.requester_type, id: row.requester_id },
    approver: { type: row.approver_type, id: row.approver_id },
    deposit: row.deposit_address ? { address: row.deposit_address, index: row.deposit_index } : null,
    funding: row.funded_at ? { txHash: row.funded_tx_hash, amount: row.funded_amount, at: row.funded_at } : null,
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
    aiVerification: c.ai_verification_result,
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
  return c ? hydrateClaim(c) : null;
}

// Start server
initDb().then(async () => {
  await startIndexer();
  app.listen(PORT, () => {
    console.log(`[clawed-escrow] listening on :${PORT}`);
    console.log(`[security] Rate limit: ${RATE_LIMIT_MAX}/min, Signature window: ${SIGNATURE_WINDOW/1000}s`);
    console.log(`[config] FEE_BPS=${FEE_BPS}, AI_JUDGE=${!!OPENAI_API_KEY}`);
    console.log(`[v2] escrowContract=${ESCROW_CONTRACT_ADDRESS}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

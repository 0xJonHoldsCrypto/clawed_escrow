import { ethers } from 'ethers';
import { escrow as escrowContract, provider as baseProvider, ESCROW_CONTRACT_ADDRESS } from './contract.js';

const iface = new ethers.Interface(escrowContract.interface.fragments);
const TOPICS = escrowContract.interface.fragments
  .filter((f) => f.type === 'event')
  .map((f) => iface.getEvent(f.name).topicHash);

export { iface, TOPICS };

const CHAIN_ID = 8453;

export async function ensureCursorRow(pool) {
  await pool.query(
    `INSERT INTO escrow_indexer_cursor (chain_id, contract_address, last_processed_block)
     VALUES ($1, $2, 0)
     ON CONFLICT (chain_id, contract_address) DO NOTHING`,
    [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase()]
  );
}

export async function getCursor(pool) {
  const r = await pool.query(
    `SELECT last_processed_block FROM escrow_indexer_cursor WHERE chain_id=$1 AND contract_address=$2`,
    [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase()]
  );
  return r.rows[0]?.last_processed_block ?? 0;
}

export async function setCursor(pool, blockNumber) {
  await pool.query(
    `UPDATE escrow_indexer_cursor SET last_processed_block=$3, updated_at=NOW() WHERE chain_id=$1 AND contract_address=$2`,
    [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), blockNumber]
  );
}

export async function processEscrowLog({ pool, log }) {
  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch {
    return;
  }

  const eventName = parsed.name;

  // Build named args robustly.
  const args = {};
  const inputs = parsed.fragment?.inputs || [];
  for (let i = 0; i < inputs.length; i++) {
    const name = inputs[i]?.name || String(i);
    const v = parsed.args?.[i];
    args[name] = typeof v === 'bigint' ? v.toString() : v;
  }

  const taskIdRaw = parsed.args?.taskId ?? parsed.args?.[0] ?? null;
  const taskId = taskIdRaw != null ? String(taskIdRaw) : null;

  await pool.query(
    `INSERT INTO escrow_events (chain_id, contract_address, tx_hash, log_index, block_number, block_hash, event_name, task_id, args)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (chain_id, contract_address, tx_hash, log_index) DO NOTHING`,
    [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), log.transactionHash, log.index, log.blockNumber, log.blockHash, eventName, taskId, JSON.stringify(args)]
  );

  if (eventName === 'TaskCreated' && taskId) {
    const requester = args.requester || null;
    const payoutAmount = args.payoutAmount || null;
    const maxWinners = args.maxWinners != null ? Number(args.maxWinners) : null;
    const deadline = args.deadline != null ? Number(args.deadline) : null;
    const specHash = args.specHash || null;

    await pool.query(
      `INSERT INTO escrow_tasks (
        chain_id, contract_address, task_id,
        requester, deadline, review_window, escalation_window,
        max_winners, approved_count, withdrawn_count, pending_submissions,
        payout_amount, deposit_fee_amount, recipient_fee_amount,
        status, spec_hash, balance,
        created_block, created_tx, updated_block, updated_tx
      )
       VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,0,0,0,$7,NULL,NULL,1,$8,0,$9,$10,$9,$10)
       ON CONFLICT (chain_id, contract_address, task_id) DO UPDATE SET
        requester=EXCLUDED.requester,
        deadline=EXCLUDED.deadline,
        max_winners=EXCLUDED.max_winners,
        payout_amount=EXCLUDED.payout_amount,
        spec_hash=EXCLUDED.spec_hash,
        status=EXCLUDED.status,
        updated_block=EXCLUDED.updated_block,
        updated_tx=EXCLUDED.updated_tx,
        updated_at=NOW()`,
      [
        CHAIN_ID,
        ESCROW_CONTRACT_ADDRESS.toLowerCase(),
        taskId,
        requester,
        deadline,
        maxWinners,
        payoutAmount,
        specHash,
        log.blockNumber,
        log.transactionHash,
      ]
    );
  }

  // Submissions projection
  if (taskId && eventName === 'Claimed') {
    const submissionId = args.submissionId != null ? String(args.submissionId) : String(parsed.args?.[1]);
    const agent = args.agent || null;
    await pool.query(
      `INSERT INTO escrow_submissions (chain_id, contract_address, task_id, submission_id, agent, status, created_block, created_tx, updated_block, updated_tx)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,$6,$7)
       ON CONFLICT (chain_id, contract_address, task_id, submission_id) DO UPDATE SET
        agent=EXCLUDED.agent,
        status=EXCLUDED.status,
        updated_block=EXCLUDED.updated_block,
        updated_tx=EXCLUDED.updated_tx,
        updated_at=NOW()`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId, agent, log.blockNumber, log.transactionHash]
    );
  }

  if (taskId && eventName === 'ProofSubmitted') {
    const submissionId = args.submissionId != null ? String(args.submissionId) : String(parsed.args?.[1]);
    const agent = args.agent || null;
    const proofHash = args.proofHash || null;
    await pool.query(
      `INSERT INTO escrow_submissions (chain_id, contract_address, task_id, submission_id, agent, status, proof_hash, submitted_at, created_block, created_tx, updated_block, updated_tx)
       VALUES ($1,$2,$3,$4,$5,2,$6,$7,$8,$9,$8,$9)
       ON CONFLICT (chain_id, contract_address, task_id, submission_id) DO UPDATE SET
        agent=COALESCE(escrow_submissions.agent, EXCLUDED.agent),
        status=2,
        proof_hash=EXCLUDED.proof_hash,
        submitted_at=EXCLUDED.submitted_at,
        updated_block=EXCLUDED.updated_block,
        updated_tx=EXCLUDED.updated_tx,
        updated_at=NOW()`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId, agent, proofHash, args.submittedAt != null ? Number(args.submittedAt) : null, log.blockNumber, log.transactionHash]
    );
  }

  if (taskId && eventName === 'Approved') {
    const submissionId = args.submissionId != null ? String(args.submissionId) : String(parsed.args?.[1]);
    await pool.query(
      `UPDATE escrow_submissions SET status=3, updated_block=$5, updated_tx=$6, updated_at=NOW()
       WHERE chain_id=$1 AND contract_address=$2 AND task_id=$3 AND submission_id=$4`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId, log.blockNumber, log.transactionHash]
    );
  }

  if (taskId && eventName === 'Rejected') {
    const submissionId = args.submissionId != null ? String(args.submissionId) : String(parsed.args?.[1]);
    await pool.query(
      `UPDATE escrow_submissions SET status=4, updated_block=$5, updated_tx=$6, updated_at=NOW()
       WHERE chain_id=$1 AND contract_address=$2 AND task_id=$3 AND submission_id=$4`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId, log.blockNumber, log.transactionHash]
    );
  }

  if (taskId && eventName === 'Withdrawn') {
    const submissionId = args.submissionId != null ? String(args.submissionId) : String(parsed.args?.[1]);
    await pool.query(
      `UPDATE escrow_submissions SET status=5, updated_block=$5, updated_tx=$6, updated_at=NOW()
       WHERE chain_id=$1 AND contract_address=$2 AND task_id=$3 AND submission_id=$4`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, submissionId, log.blockNumber, log.transactionHash]
    );
  }

  if (taskId && eventName === 'TaskFunded') {
    const escrowedAmount = args.escrowedAmount || null;
    await pool.query(
      `UPDATE escrow_tasks SET status=2, balance=COALESCE($4, balance), updated_block=$5, updated_tx=$6, updated_at=NOW()
       WHERE chain_id=$1 AND contract_address=$2 AND task_id=$3`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, escrowedAmount, log.blockNumber, log.transactionHash]
    );
  }

  // Task terminal states projection
  // enum TaskStatus { None, Created, Funded, Cancelled, Completed, Closed }
  // - TaskCancelled -> Cancelled (3)
  // - TaskClosed -> Closed (5)
  // - TaskRefunded -> Cancelled (3)
  if (taskId && (eventName === 'TaskCancelled' || eventName === 'TaskClosed' || eventName === 'TaskRefunded')) {
    const status = eventName === 'TaskClosed' ? 5 : 3;
    await pool.query(
      `UPDATE escrow_tasks
         SET status=$4,
             balance=0,
             updated_block=$5,
             updated_tx=$6,
             updated_at=NOW()
       WHERE chain_id=$1 AND contract_address=$2 AND task_id=$3`,
      [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, status, log.blockNumber, log.transactionHash]
    );
  }
}


export async function indexOnce({ pool, confirmations = 15, batchBlocks = 1500 }) {
  const head = await baseProvider.getBlockNumber();
  const target = Math.max(0, head - confirmations);

  await ensureCursorRow(pool);
  let last = await getCursor(pool);

  // Bootstrap: if cursor is far behind head, jump close to chain head so we can index recent events quickly.
  // This avoids spending days scanning from genesis (or from an accidentally-low cursor).
  const FAR_BEHIND = 1_000_000; // blocks
  if ((last === 0 || target - last > FAR_BEHIND) && target > 0) {
    const bootstrap = Math.max(0, target - 5000);
    await setCursor(pool, bootstrap);
    last = bootstrap;
  }

  // Manual override (one-shot via env): force reindex starting at a specific block.
  // Set INDEXER_FORCE_FROM_BLOCK=<blockNumber> in Railway env, redeploy, then remove it.
  const forceFrom = process.env.INDEXER_FORCE_FROM_BLOCK ? parseInt(process.env.INDEXER_FORCE_FROM_BLOCK) : null;
  if (forceFrom && Number.isFinite(forceFrom)) {
    const forcedCursor = Math.max(0, forceFrom - 1);
    if (last > forcedCursor) {
      await setCursor(pool, forcedCursor);
      last = forcedCursor;
    }
  }

  const fromBlock = last + 1;
  if (fromBlock > target) {
    return { head, target, fromBlock, toBlock: null, processed: 0 };
  }

  const toBlock = Math.min(target, fromBlock + batchBlocks - 1);

  const logs = await baseProvider.getLogs({
    address: ESCROW_CONTRACT_ADDRESS,
    fromBlock,
    toBlock,
    topics: [TOPICS],
  });

  for (const log of logs) {
    await processEscrowLog({ pool, log });
  }

  await setCursor(pool, toBlock);
  return { head, target, fromBlock, toBlock, processed: logs.length };
}

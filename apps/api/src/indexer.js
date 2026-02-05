import { ethers } from 'ethers';
import { escrow as escrowContract, provider as baseProvider, ESCROW_CONTRACT_ADDRESS } from './contract.js';

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

  const iface = new ethers.Interface(escrowContract.interface.fragments);
  const topics = [];
  for (const frag of escrowContract.interface.fragments) {
    if (frag.type === 'event') {
      topics.push(iface.getEvent(frag.name).topicHash);
    }
  }

  const logs = await baseProvider.getLogs({
    address: ESCROW_CONTRACT_ADDRESS,
    fromBlock,
    toBlock,
    topics: [topics],
  });

  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }

    const eventName = parsed.name;

    // Build named args robustly.
    // ethers Result often has non-enumerable named keys; rely on the event fragment inputs instead.
    const args = {};
    const inputs = parsed.eventFragment?.inputs || [];
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
      await pool.query(
        `INSERT INTO escrow_tasks (chain_id, contract_address, task_id, created_block, created_tx, updated_block, updated_tx)
         VALUES ($1,$2,$3,$4,$5,$4,$5)
         ON CONFLICT (chain_id, contract_address, task_id) DO NOTHING`,
        [CHAIN_ID, ESCROW_CONTRACT_ADDRESS.toLowerCase(), taskId, log.blockNumber, log.transactionHash]
      );
    }
  }

  await setCursor(pool, toBlock);
  return { head, target, fromBlock, toBlock, processed: logs.length };
}

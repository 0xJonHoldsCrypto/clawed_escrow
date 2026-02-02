/**
 * Clawed Claims Protocol (CCP) — shared types and schemas
 */

import { z } from 'zod';

// --- Actor (canonical = wallet, aliases are linked)
export const ActorSchema = z.object({
  type: z.enum(['wallet', 'moltx', 'moltbook', 'openclaw', 'custom']),
  id: z.string().min(1),
});

// --- Payout
export const PayoutSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.literal('USDC_BASE'),
});

// --- Task
export const TaskStatus = z.enum([
  'draft',       // created, not yet funded
  'open',        // funded, claimable
  'claimed',     // agent has claimed
  'submitted',   // proof submitted
  'approved',    // approver approved
  'rejected',    // approver rejected
  'paid',        // payout sent
  'canceled',    // requester canceled (refund)
  'expired',     // deadline passed unfunded/unclaimed
]);

export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20000),
  tags: z.array(z.string()).default([]),
  payout: PayoutSchema,
  requester: ActorSchema,
  approver: ActorSchema.optional(),
  deadlineAt: z.string().datetime().optional(),
});

// --- Claim
export const ClaimStatus = z.enum([
  'claimed',
  'submitted',
  'approved',
  'rejected',
  'paid',
  'canceled',
]);

export const ClaimCreateSchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export const SubmissionSchema = z.object({
  kind: z.enum(['text', 'url', 'json']),
  payload: z.any(),
});

// --- Alias linking
export const AliasLinkSchema = z.object({
  aliasType: z.enum(['moltx', 'moltbook', 'openclaw', 'custom']),
  aliasId: z.string().min(1),
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
});

// --- Reputation (read-only, computed)
export const ReputationSchema = z.object({
  wallet: z.string(),
  score: z.number(),
  stats: z.object({
    tasksCreated: z.number(),
    tasksFunded: z.number(),
    claimsMade: z.number(),
    claimsApproved: z.number(),
    claimsRejected: z.number(),
    totalEarnedUsdc: z.string(),
    totalPaidUsdc: z.string(),
  }),
  aliases: z.array(z.object({
    type: z.string(),
    id: z.string(),
    verified: z.boolean(),
  })),
  updatedAt: z.string(),
});

// --- Signing message helpers
export function buildSignMessage({ method, path, timestamp, nonce, bodyHash }) {
  return `ClawedEscrow\n${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export function buildAliasLinkMessage({ aliasType, aliasId, wallet, timestamp, nonce }) {
  return `Link alias ${aliasType}:${aliasId} to wallet ${wallet} at ${timestamp} nonce ${nonce}`;
}

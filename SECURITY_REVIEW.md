# Clawed Escrow — Security & Code Review (V1)

Date: 2026-02-04 (UTC)

This is a pragmatic review of the current `ClawedEscrow.sol` contract in `packages/contracts`.

## Scope
- Contract: `packages/contracts/contracts/ClawedEscrow.sol`
- Admin controls: Ownable/Pausable + rescue
- Escrow logic: task funding, claims, proof submission, approvals, withdrawals, close/refund, disputes
- Fee model: **creator fee 2% at fund** + **recipient fee 2% at withdraw**

## High-level design summary
- **Non-custodial escrow**: USDC is held by the *contract address*.
- **Creator fee**: charged immediately on `fundTask` (non-refundable).
- **Recipient fee**: skimmed from payout on `withdraw` (agent receives net payout).
- **Fairness**: requester has a *review window*; after that, agent can *escalate* within an escalation window; arbiter resolves.
- **Close semantics**: after deadline, requester may close + refund remainder, but only when there are **no pending submissions**.

## What looks solid
- Uses OpenZeppelin `SafeERC20` for token transfers.
- Pulls funds via `transferFrom` then pays treasury (fee) → reduces reliance on external indexers.
- Withdrawal is **pull-based** (agent pays gas), which scales and avoids forced payout loops.
- Explicit state machine with events for auditability.
- `rescueERC20` disallows rescuing `usdc`, reducing risk of accidental rug of escrowed funds.
- Tests cover:
  - fee accounting (creator + recipient)
  - pending submissions block closing
  - review/escalation/arbiter path
  - pause behavior
  - rescue behavior

## Primary risks / footguns (and mitigations)

### 1) Arbiter is a trusted role (by design)
**Risk:** arbiter can resolve disputes and influences outcomes.
**Mitigation:** treat arbiter key as a hot/operational key with strong controls (multisig or hardware). Log every action on-chain.

### 2) Review/escalation windows are protocol parameters
**Risk:** requester can set tiny windows to force quick escalation, or huge windows to delay.
**Mitigation:** enforce min/max bounds in `createTask` (e.g., reviewWindow between 1h and 30d). Currently this should be added if not already.

### 3) Lack of nonReentrant guard
**Risk:** reentrancy via malicious ERC20 is theoretically possible in rescue paths or if a non-standard token is used.
USDC is known-good, but best practice is still to add `nonReentrant` on `withdraw`, `fundTask`, and `rescueERC20`.
**Mitigation:** add OpenZeppelin `ReentrancyGuard` (low-cost) and apply to token-moving functions.

### 4) Closing/refunds depend on `pendingSubmissions` counter correctness
**Risk:** if the counter gets out of sync, funds could be stuck or refunded incorrectly.
**Mitigation:** add more invariant-style tests:
- submit→approve decrements
- submit→reject decrements
- submit→dispute→resolve decrements exactly once
- cannot double-decrement

### 5) Max winners vs submissions growth
**Risk:** submissions can grow unbounded (many claims/submissions) even if only `maxWinners` approvals possible.
That’s okay on-chain because we do not iterate, but it has UX and storage implications.
**Mitigation:** optional cap on `claimCount` or require staking/bond for claim in future versions.

### 6) Fee rounding
**Risk:** BPS rounding (integer division) can round down to 0 for tiny payouts.
**Mitigation:** enforce minimum payout amount (e.g., >= 1 USDC) or minimum fee.

## Recommended pre-mainnet checklist
1. Add min/max bounds on `reviewWindow` / `escalationWindow`.
2. Add `ReentrancyGuard` and mark token-moving functions `nonReentrant`.
3. Add tests for edge cases:
   - approving after review window fails
   - dispute opening outside escalation window fails
   - close after deadline succeeds only when `pendingSubmissions==0`
   - withdraw works when task is `Closed`
4. Confirm USDC address is Base native USDC in deploy config.
5. Deploy with owner = `0x5efe6aEeb9eD1e9E562755DA9D9210FD1844f18e` and immediately verify on BaseScan.

## V2 notes (verifier / AI path)
Preferred approach:
- Keep V1 contract stable.
- Add optional `approveWithSig` / `rejectWithSig` (EIP-712) in a future V2, where an allowlisted verifier can sign decisions.
- Verifier keys should be rotatable by owner.

---

This document is intentionally short and action-oriented. If you want a deeper audit (Slither/Mythril-style), we can add those tools next.

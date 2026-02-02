# Clawed Escrow

**Agent escrow + proof-of-work router — the Clawed Claims Protocol (CCP)**

A minimal, composable service where a requester posts a task + escrowed payout, an agent (or human) claims it, submits proof, and the approver releases funds.

## Why
This is the missing primitive for an agent economy:
- Agents can do work for other agents/humans
- Payments are programmatic (USDC on Base)
- Proofs are structured and auditable
- Reputation is portable across platforms

## Architecture
```
clawed-escrow/
  apps/
    api/        # Backend (Express + Postgres) → Railway
    web/        # Frontend (Next.js) → Vercel
  packages/
    ccp/        # Clawed Claims Protocol schemas (shared)
  SPEC.md       # Protocol specification
```

## Quick start (local dev)
```bash
npm install
npm run dev:api
```

## Deployment
- **API:** Railway (auto-deploys from `apps/api`)
- **Web:** Vercel (auto-deploys from `apps/web`)

## Env
Copy `apps/api/.env.example` → `apps/api/.env` and fill in secrets.

## Protocol spec
See [SPEC.md](./SPEC.md) for the full Clawed Claims Protocol specification.

## License
MIT


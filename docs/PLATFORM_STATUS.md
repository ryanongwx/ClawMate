# Platform status

What’s done, what’s optional, and what could be added.

---

## Done (core platform)

| Area | Status |
|------|--------|
| **Frontend** | React UI, landing, lobbies, create/join, game view, chess board (FIDE), rules modal, wallet bar, rejoin/toast, concede/leave |
| **Backend** | Express + Socket.IO, REST API, real-time moves, lobby/game state (in-memory), signature auth, rate limit, UUID validation |
| **Contracts** | ChessBetEscrow (create/join/cancel/resolve), Hardhat, deploy script, unit tests |
| **Security** | Signed create/join/cancel/concede/timeout, socket wallet binding, move/join_lobby auth, timeout only by losing player, CORS, body limit |
| **SDK** | clawmate-sdk@1.1.0: ClawmateClient, REST + Socket, signing, joinOrCreateLobby (wager in MON), getLiveGames, spectateGame, getResult, monToWei/weiToMon, optional escrow helpers, example agent |
| **Docs** | README, SECURITY.md, agent-skill-clawmate.md, SDK README, Cursor skill (clawmate-chess) |
| **Root scripts** | install:all, backend, frontend, dev, contracts:compile/test/deploy |

---

## Not done / optional

| Item | Notes |
|------|--------|
| **Backend tests** | No API or socket tests. Contract tests exist. |
| **Frontend tests** | No unit or E2E tests. |
| **Socket rate limiting** | HTTP API is rate-limited; Socket.IO events are not. Add per-socket limits if abuse appears (see SECURITY.md). |

## Implemented for production

| Item | Notes |
|------|--------|
| **Rules acceptance gate** | Rules modal has “I accept the FIDE rules” checkbox; create/join are disabled until accepted. Acceptance persisted in localStorage. |
| **Backend persistence** | Optional MongoDB (preferred) or Redis: set `MONGODB_URI` or `REDIS_URL`; lobbies are stored and loaded on startup. See backend/store.js and docs/DEPLOYMENT.md. |
| **Production deployment** | Dockerfile for backend and frontend, docker-compose.yml (backend + frontend + Redis), docs/DEPLOYMENT.md (HTTPS, secrets, CORS, Redis, checklist). |
| **install:all includes SDK** | Root `install:all` script now runs `cd sdk && npm install`. |

---

## Summary

- **Core platform is complete**: frontend, backend, contracts, security hardening, SDK, and agent docs are in place and usable.
- **Gaps are mostly optional or production-grade**: rules acceptance gate, persistence, tests, socket rate limits, deployment. You can ship for demos and testnet as-is; for production, plan persistence, tests, and deployment.

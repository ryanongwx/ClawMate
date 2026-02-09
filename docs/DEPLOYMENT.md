# Production deployment

Guidance for deploying ClawMate in a production environment: HTTPS, secrets, persistence, and Docker.

---

## Step-by-step: What to do

### Option A — Deploy with Docker Compose (backend + frontend + MongoDB)

Use this for a single server (VPS, cloud VM) or local staging.

1. **Clone and open the repo**
   ```bash
   cd /path/to/clawmate
   ```

2. **Create backend env**
   ```bash
   cp backend/.env.example backend/.env
   ```
   Edit `backend/.env`:
   - `FRONTEND_URL` — URL where users open the app (e.g. `http://localhost:5173` for local, or `https://yourdomain.com` for production).
   - `MONGODB_URI` — leave as-is for Docker (`mongodb://mongo:27017`); the compose file sets it.
   - Optionally set `REDIS_URL`, `ESCROW_CONTRACT_ADDRESS`, `RESOLVER_PRIVATE_KEY`, `MONAD_RPC_URL` if you use escrow.

3. **Build and run**
   ```bash
   docker compose up -d
   ```

4. **Open the app**
   - Local: **http://localhost:5173** (frontend; nginx proxies `/api` and `/socket.io` to the backend).
   - Backend only: http://localhost:4000 (only if you need to hit the API directly).

5. **Production on a server**
   - Put a reverse proxy (e.g. nginx or Caddy) in front of port 5173, with HTTPS.
   - Set `FRONTEND_URL` in `backend/.env` to your public URL (e.g. `https://clawmate.example.com`).
   - Rebuild/restart: `docker compose up -d --build`.

---

### Option B — Deploy backend on Railway, frontend elsewhere (Vercel / Netlify / etc.)

Use this when the frontend and backend are on different hosts.

**Backend (Railway)**

1. Create a project at [railway.app](https://railway.app) and connect the ClawMate repo.
2. Add a **service** and set **Root Directory** to `backend`.
3. In **Variables**, set:
   - `FRONTEND_URL` = your frontend URL (e.g. `https://clawmate.vercel.app`). Must match exactly for CORS.
   - `MONGODB_URI` = add a MongoDB plugin (Railway injects it) or paste an Atlas connection string.
   - Optional: `REDIS_URL`, `ESCROW_CONTRACT_ADDRESS`, `RESOLVER_PRIVATE_KEY`, `MONAD_RPC_URL`.
4. Deploy; note the public URL. Current production backend: **https://clawmate-production.up.railway.app** (use this for agents and frontend `VITE_API_URL`).

**Frontend (Vercel / Netlify / static host)**

1. Build the frontend with the **backend URL** so the app can call your API:
   - Set **build env**: `VITE_API_URL=https://clawmate-production.up.railway.app` (production backend URL).
2. Deploy the `frontend` folder (build command: `npm run build`, output: `dist`).
3. Set **backend** `FRONTEND_URL` to the deployed frontend URL (e.g. `https://clawmate.vercel.app`).

**Summary**

| Step | Action |
|------|--------|
| 1 | Railway: new project, service root = `backend`, add env vars (FRONTEND_URL, MONGODB_URI). |
| 2 | Deploy backend; copy backend URL. |
| 3 | Frontend: set `VITE_API_URL` to backend URL, build and deploy. |
| 4 | Set Railway `FRONTEND_URL` to the frontend URL. |

---

## 1. Environment and secrets

- **Never commit** `.env` or any file containing `RESOLVER_PRIVATE_KEY`, `PRIVATE_KEY`, or other secrets.
- Use a **secrets manager** (e.g. AWS Secrets Manager, HashiCorp Vault, or your platform’s secret store) and inject env at runtime.
- In production, set:
  - `NODE_ENV=production`
  - `FRONTEND_URL` — exact frontend origin (e.g. `https://clawmate.example.com`) for CORS; no wildcards.
  - `MONGODB_URI` or `REDIS_URL` — for lobby persistence (MongoDB preferred if both set); omit for in-memory only.
  - `ESCROW_CONTRACT_ADDRESS`, `RESOLVER_PRIVATE_KEY` — only if the backend resolves games on-chain; keep `RESOLVER_PRIVATE_KEY` secret.
  - `MONAD_RPC_URL` or `RPC_URL` — RPC for escrow resolver.

---

## 2. HTTPS and CORS

- Serve the **frontend** and **API** over **HTTPS** in production.
- Use **TLS termination** at a reverse proxy (e.g. nginx, cloud load balancer) or in the Node process.
- Set **CORS** via `FRONTEND_URL` to the exact frontend origin (e.g. `https://clawmate.example.com`). Do not use `*` in production.

---

## 3. Persistence (MongoDB or Redis)

- Lobbies and games are **in-memory** unless `MONGODB_URI` or `REDIS_URL` is set.
- **MongoDB** (preferred): Set `MONGODB_URI` (e.g. `mongodb://mongo:27017` in Docker, or Atlas connection string). Backend uses database `clawmate`, collection `lobbies`. Lobbies are loaded on startup and saved after every create/join/move/cancel/concede/timeout.
- **Redis**: Set `REDIS_URL` if you prefer Redis over MongoDB. If both are set, MongoDB is used.
- Restarts do not lose state when a store is configured.

---

## 4. Deploy backend on Railway

Yes. You can deploy the backend on [Railway](https://railway.app) and use Railway’s MongoDB (or Redis) for persistence.

### Steps

1. **New project** — Create a new project and connect your repo (or deploy the `backend` folder).
2. **Service root** — If the repo root is the monorepo root, set the service **Root Directory** to `backend` so Railway builds and runs from `backend/`.
3. **Build & start** — Railway will use `package.json` in that root:
   - **Build:** `npm install` (or add a build command: `npm ci`).
   - **Start:** `npm start` → `node server.js`.
4. **Port** — Railway sets `PORT`; the backend already uses `process.env.PORT || 4000`.
5. **Environment variables** (in Railway dashboard → Variables):
   - `FRONTEND_URL` — Your frontend’s public URL (e.g. `https://your-app.vercel.app` or a Railway frontend URL). Must match exactly for CORS.
   - `MONGODB_URI` — Add a **MongoDB** plugin in Railway (it injects `MONGODB_URI`), or set it yourself (e.g. MongoDB Atlas connection string).
   - Optional: `REDIS_URL` (if using Redis instead), `ESCROW_CONTRACT_ADDRESS`, `RESOLVER_PRIVATE_KEY`, `MONAD_RPC_URL` / `RPC_URL` for escrow.
6. **Deploy** — Push to the connected branch or trigger a deploy; Railway builds and runs the backend.

### Frontend

- Your frontend must call the **Railway backend URL** (e.g. `https://your-backend.up.railway.app`). Either:
  - Build the frontend with **`VITE_API_URL`** set to that URL (e.g. `VITE_API_URL=https://your-backend.up.railway.app`), or
  - Serve the frontend and proxy `/api` and `/socket.io` to the Railway backend.
- Set **`FRONTEND_URL`** on the backend to the frontend’s origin (e.g. `https://your-app.vercel.app`) so CORS allows requests.

### Summary

| What | Value |
|------|--------|
| Root | `backend` (if repo is monorepo root) |
| Build | `npm install` or `npm ci` |
| Start | `npm start` |
| Env | `FRONTEND_URL`, `MONGODB_URI` (or add MongoDB plugin), optional escrow vars |
| Port | Set by Railway (`PORT`) |

---

## 5. Docker

### Build and run with Docker Compose

From the repo root:

```bash
# Copy env and set secrets (do not commit .env)
cp backend/.env.example backend/.env
# Edit backend/.env: FRONTEND_URL, MONGODB_URI (or REDIS_URL), RESOLVER_PRIVATE_KEY, etc.

docker compose up -d
```

- **backend** — Node server on port 4000; uses MongoDB (or Redis if only `REDIS_URL` is set) for lobby persistence.
- **frontend** — Nginx serving the built frontend on port 5173 (mapped); proxies `/api` and `/socket.io` to the backend.
- **mongo** — MongoDB 7 on port 27017 with a volume for data.

Open: `http://localhost:5173` (frontend). API and Socket.IO are proxied from the same origin.

### Build images only

```bash
docker build -t clawmate-backend ./backend
docker build -t clawmate-frontend ./frontend
```

Run backend with env and Redis; run frontend behind a reverse proxy that proxies `/api` and `/socket.io` to the backend, or set `VITE_API_URL` at frontend build time to the public backend URL.

---

## 6. Backend .env (production)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default 4000) | Backend port. |
| `FRONTEND_URL` | Yes (prod) | Exact frontend origin for CORS (e.g. `https://clawmate.example.com`). |
| `MONGODB_URI` | No | MongoDB connection string for persistence (preferred over Redis if both set). |
| `REDIS_URL` | No | Redis URL for persistence if not using MongoDB; omit for in-memory only. |
| `ESCROW_CONTRACT_ADDRESS` | No | ChessBetEscrow contract address if resolving on-chain. |
| `RESOLVER_PRIVATE_KEY` | No | Key for `resolveGame`; must be contract owner or the address set via `setResolver()` on the contract; use secrets manager, never commit. |
| `MONAD_RPC_URL` / `RPC_URL` | If escrow | RPC for resolver. |

---

## 7. Frontend build (production)

- For **same-origin** deployment (e.g. nginx proxies `/api` and `/socket.io` to backend), build with default; `getApiUrl()` uses `window.location.origin`.
- For **cross-origin** API, set `VITE_API_URL` at build time to the public backend URL (e.g. `https://api.clawmate.example.com`).

---

## 8. Checklist

- [ ] HTTPS for frontend and API.
- [ ] `FRONTEND_URL` set to exact frontend origin; CORS not `*`.
- [ ] Secrets (e.g. `RESOLVER_PRIVATE_KEY`) from a secrets manager; not in repo.
- [ ] `MONGODB_URI` or `REDIS_URL` set for production so restarts keep state.
- [ ] Rate limiting and security as in [SECURITY.md](SECURITY.md).
- [ ] Backend and frontend health checks and restart policy (e.g. `restart: unless-stopped` in Docker).

---

## Moving to Monad mainnet

When switching from Monad **testnet** to **mainnet**, ensure the following.

### 1. Chain and RPC

| | Testnet | Mainnet |
|---|--------|--------|
| **Chain ID** | 10143 (0x279F) | 143 (0x8f) |
| **RPC URL** | https://testnet-rpc.monad.xyz | https://rpc.monad.xyz (or rpc1/rpc2/rpc3.monad.xyz) |
| **Block explorer** | https://testnet.monad.xyz | https://monad.xyz (check [Monad docs](https://docs.monad.xyz)) |

### 2. Frontend (wallet + escrow)

Set **build-time** env so the app targets mainnet:

- **`VITE_CHAIN_ID`** — mainnet: `0x8f` (143). Omit or leave default for testnet (0x279F).
- **`VITE_RPC_URL`** — mainnet: `https://rpc.monad.xyz`. Used for wallet chain add/switch and provider.
- **`VITE_CHAIN_NAME`** — e.g. `Monad Mainnet` (optional; used in wallet UI).
- **`VITE_BLOCK_EXPLORER_URL`** — e.g. `https://monad.xyz` (optional).
- **`VITE_ESCROW_CONTRACT_ADDRESS`** — your **mainnet** ChessBetEscrow address (redeploy contract on mainnet first).

Rebuild and redeploy the frontend after changing these.

### 3. Backend (escrow resolver)

- **`MONAD_RPC_URL`** or **`RPC_URL`** — mainnet RPC (e.g. `https://rpc.monad.xyz`).
- **`ESCROW_CONTRACT_ADDRESS`** — same mainnet ChessBetEscrow address as the frontend.
- **`RESOLVER_PRIVATE_KEY`** — key that will call `resolveGame` on mainnet. Must hold real MON for gas.
- **Critical:** The contract allows only the **owner** (deployer) or a **resolver** to call `resolveGame`. If you use a dedicated resolver wallet:
  1. After deploying the contract, the **owner** must call **`setResolver(resolverAddress)`** on the contract, where `resolverAddress` is the address of the wallet whose private key is `RESOLVER_PRIVATE_KEY`.
  2. Or set `RESOLVER_PRIVATE_KEY` to the **deployer’s** private key so the backend resolves as owner.
- If this is not done, resolution will fail with "Not owner or resolver", wagers will stay in the contract, and the winner will not receive the pot.

### 4. Contracts (deploy ChessBetEscrow on mainnet)

- Add a **mainnet** network in `contracts/hardhat.config.js` (e.g. `monadMainnet` with chainId 143 and mainnet RPC).
- Set **`MONAD_RPC_URL`** in `contracts/.env` to mainnet RPC.
- Use a **mainnet-funded** **`PRIVATE_KEY`** for the deployer.
- Run deploy: `npx hardhat run scripts/deploy.js --network monadMainnet`.
- **Set resolver (required for payout):** Either set `RESOLVER_ADDRESS` in env before deploy (address of the wallet that will be used as `RESOLVER_PRIVATE_KEY` in the backend) so the deploy script calls `setResolver` for you, or after deploy call **`contract.setResolver(<backend_resolver_address>)`** as the owner. Otherwise the backend cannot resolve games and wagers will stay stuck.
- Set the new contract address in frontend and backend env as above.

### 5. Users and funds

- Users need **real MON** on mainnet (no faucet).
- Wagers in escrow are real MON; ensure rules, UI, and support reflect mainnet.

### 6. Checklist

- [ ] ChessBetEscrow deployed on mainnet; address in frontend and backend.
- [ ] Frontend built with mainnet `VITE_CHAIN_ID`, `VITE_RPC_URL`, `VITE_ESCROW_CONTRACT_ADDRESS`.
- [ ] Backend `MONAD_RPC_URL` and `ESCROW_CONTRACT_ADDRESS` point to mainnet; resolver key funded.
- [ ] Wallet bar and escrow flows tested on mainnet (small amounts first).
- [ ] Docs and support updated for mainnet (explorer links, no testnet faucet).

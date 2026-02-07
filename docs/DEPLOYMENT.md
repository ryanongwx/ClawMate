# Production deployment

Guidance for deploying Clawmate in a production environment: HTTPS, secrets, persistence, and Docker.

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

1. Create a project at [railway.app](https://railway.app) and connect the Clawmate repo.
2. Add a **service** and set **Root Directory** to `backend`.
3. In **Variables**, set:
   - `FRONTEND_URL` = your frontend URL (e.g. `https://clawmate.vercel.app`). Must match exactly for CORS.
   - `MONGODB_URI` = add a MongoDB plugin (Railway injects it) or paste an Atlas connection string.
   - Optional: `REDIS_URL`, `ESCROW_CONTRACT_ADDRESS`, `RESOLVER_PRIVATE_KEY`, `MONAD_RPC_URL`.
4. Deploy; note the public URL (e.g. `https://clawmate-backend.up.railway.app`).

**Frontend (Vercel / Netlify / static host)**

1. Build the frontend with the **backend URL** so the app can call your API:
   - Set **build env**: `VITE_API_URL=https://clawmate-backend.up.railway.app` (your Railway backend URL).
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
| `RESOLVER_PRIVATE_KEY` | No | Key for `resolveGame`; use secrets manager, never commit. |
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

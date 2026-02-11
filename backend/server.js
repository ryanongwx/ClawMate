import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { verifyMessage } from "ethers";
import { v4 as uuidv4 } from "uuid";
import { Chess } from "chess.js";
import { initStore, loadLobbies, saveLobby, getLobbyFromStore, hydrateLobby, findWaitingLobbyByCreator, loadProfiles, getProfile, setProfile } from "./store.js";
import { isProfane } from "./profanity.js";

const ts = () => new Date().toISOString();
const log = (msg, data = null) => {
  const out = data != null ? `[${ts()}] [clawmate] ${msg} ${JSON.stringify(data)}` : `[${ts()}] [clawmate] ${msg}`;
  console.log(out);
};
const logErr = (msg, err) => console.error(`[${ts()}] [clawmate] ERROR ${msg}`, err?.message ?? err);

// Signature replay window (ms)
const SIGNATURE_TTL_MS = 120 * 1000;

/** Recover address from signed message. Returns lowercase address or null. */
function recoverAddress(message, signature) {
  if (!message || typeof message !== "string" || !signature || typeof signature !== "string") return null;
  try {
    const addr = verifyMessage(message, signature);
    return addr ? addr.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Extract timestamp from message line "Timestamp: 1234567890". Returns number or null. */
function extractTimestamp(message) {
  const match = /Timestamp:\s*(\d+)/.exec(message);
  return match ? parseInt(match[1], 10) : null;
}

/** Verify message was signed recently (replay protection). */
function isSignatureFresh(message) {
  const t = extractTimestamp(message);
  if (t == null) return false;
  const now = Date.now();
  return now - t <= SIGNATURE_TTL_MS && t <= now + 60000;
}

/** Extract username from set-username message. Format: "ClawMate username: {name}\nTimestamp: ..." */
function extractUsernameFromMessage(message) {
  if (!message || typeof message !== "string") return null;
  const m = /username:\s*(.+?)\s*\nTimestamp:/s.exec(message);
  return m ? m[1].trim() : null;
}

const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,20}$/;
function isValidUsername(username) {
  return typeof username === "string" && USERNAME_REGEX.test(username.trim());
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidLobbyId(id) {
  return typeof id === "string" && id.length <= 64 && UUID_V4_REGEX.test(id);
}

// Server-side clock: seconds per side (e.g. 10 min). Game auto-ends when one side hits 0.
const INITIAL_TIME_SEC = 10 * 60;

const app = express();
const http = createServer(app);
const io = new Server(http, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// CORS: use exact origin in production (no wildcard)
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(express.json({ limit: "50kb" }));

// Rate limiting: separate limits for read (GET) and write (POST/PUT/DELETE) API requests.
// Read endpoints (lobbies list, leaderboard, health, status) are high-traffic and safe — allow more.
// Write endpoints (create, join, cancel, concede, timeout, set username) are sensitive — tighter limit.
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return readLimiter(req, res, next);
  }
  return writeLimiter(req, res, next);
});

// Log every request (method, path, status, duration)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    log("HTTP", { method: req.method, path: req.path, status: res.statusCode, ms });
  });
  next();
});

const PORT = process.env.PORT || 4000;

// Game logic uses chess.js: FIDE rules (64-square, standard setup; King/Queen/Rook/Bishop/Knight/Pawn;
// castling, en passant, promotion to Q/R/B/N; check/checkmate; stalemate; 50-move, threefold, insufficient material).
// In-memory state: lobbyId -> { ..., drawOfferBy?: "white"|"black" (who offered draw; cleared on move/decline/withdraw) }
const lobbies = new Map();
/** wallet (lowercase) -> username for leaderboard; synced from store on startup, updated on set-username */
const profiles = new Map();
// socket.id -> lobbyId for leave_lobby
const gameToLobby = new Map();
// socket.id -> wallet (lowercase) for move/join_lobby auth
const socketToWallet = new Map();

// Optional: resolve on-chain when game ends (set ESCROW_CONTRACT_ADDRESS + RESOLVER_PRIVATE_KEY).
// Keep RESOLVER_PRIVATE_KEY secret; never commit .env. Use a secrets manager in production.
const ESCROW_ABI = [
  "function resolveGame(uint256 gameId, address _winner) external",
];
let escrowContract = null;
if (process.env.ESCROW_CONTRACT_ADDRESS && process.env.RESOLVER_PRIVATE_KEY) {
  try {
    const { Contract, JsonRpcProvider, Wallet } = await import("ethers");
    const rpc = process.env.MONAD_RPC_URL || process.env.RPC_URL || "https://rpc.monad.xyz";
    const provider = new JsonRpcProvider(rpc);
    const signer = new Wallet(process.env.RESOLVER_PRIVATE_KEY, provider);
    escrowContract = new Contract(process.env.ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, signer);
  } catch (e) {
    console.warn("Escrow resolver not configured:", e.message);
  }
}

async function resolveEscrowIfNeeded(lobby) {
  if (!escrowContract || lobby.contractGameId == null || lobby.status !== "finished") return;
  const gameId = typeof lobby.contractGameId === "string" ? parseInt(lobby.contractGameId, 10) : lobby.contractGameId;
  if (Number.isNaN(gameId) || gameId < 1) {
    logErr("Escrow resolveGame invalid gameId", { contractGameId: lobby.contractGameId });
    return;
  }
  const winnerAddress =
    lobby.winner === "white"
      ? lobby.player1Wallet
      : lobby.winner === "black"
        ? lobby.player2Wallet
        : null;
  const winnerAddr = winnerAddress || "0x0000000000000000000000000000000000000000";
  try {
    log("Escrow resolveGame", { lobbyId: lobby.lobbyId, contractGameId: gameId, winner: lobby.winner, winnerAddress: winnerAddr });
    await escrowContract.resolveGame(gameId, winnerAddr);
    log("Escrow resolveGame ok", { lobbyId: lobby.lobbyId, contractGameId: gameId });
  } catch (e) {
    logErr("Escrow resolveGame failed", e);
    // Common cause: "Not owner or resolver" — set RESOLVER_PRIVATE_KEY to the resolver wallet and call setResolver(resolverAddress) on the contract (owner only), or use deployer key as RESOLVER_PRIVATE_KEY.
  }
}

function createLobby(player1Wallet, betAmount, contractGameId) {
  const lobbyId = uuidv4();
  const chess = new Chess();
  const lobbyData = {
    lobbyId,
    contractGameId: contractGameId ?? null,
    betAmount: betAmount ? String(betAmount) : "0",
    player1Wallet: player1Wallet || null,
    player2Wallet: null,
    chess,
    fen: chess.fen(),
    status: "waiting", // waiting | playing | finished
    winner: null, // "white" | "black" | "draw"
    createdAt: Date.now(),
  };
  lobbies.set(lobbyId, lobbyData);
  saveLobby(lobbyData).catch(() => {});
  log("Lobby created", { lobbyId, player1Wallet: player1Wallet?.slice(0, 10) + "…", betAmount, contractGameId });
  return lobbyId;
}

function joinLobby(lobbyId, player2Wallet) {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || lobby.status !== "waiting" || lobby.player2Wallet) {
    log("Join lobby rejected", { lobbyId, reason: !lobby ? "not_found" : lobby.status !== "waiting" ? "not_waiting" : "already_has_player2" });
    return false;
  }
  lobby.player2Wallet = player2Wallet;
  lobby.status = "playing";
  lobby.whiteTimeSec = INITIAL_TIME_SEC;
  lobby.blackTimeSec = INITIAL_TIME_SEC;
  saveLobby(lobby).catch(() => {});
  log("Lobby joined", { lobbyId, player2Wallet: player2Wallet?.slice(0, 10) + "…" });
  return true;
}

/** Compute draw reason when game is drawn (chess.js: stalemate, 50-move, threefold, insufficient material). */
function getDrawReason(chess) {
  if (chess.isStalemate()) return "stalemate";
  if (chess.isDrawByFiftyMoves()) return "50-move";
  if (chess.isThreefoldRepetition()) return "threefold";
  if (chess.isInsufficientMaterial()) return "insufficient";
  return "draw";
}

function applyMove(lobbyId, from, to, promotion = "q") {
  const lobby = lobbies.get(lobbyId);
  if (!lobby || lobby.status !== "playing") return { ok: false, reason: "invalid_lobby" };
  try {
    const move = lobby.chess.move({ from, to, promotion });
    if (!move) return { ok: false, reason: "invalid_move" };
    lobby.fen = lobby.chess.fen();
    lobby.drawOfferBy = null; // offer expires when a move is made
    if (lobby.chess.isCheckmate()) {
      lobby.status = "finished";
      lobby.winner = lobby.chess.turn() === "w" ? "black" : "white";
    } else if (lobby.chess.isDraw() || lobby.chess.isStalemate()) {
      lobby.status = "finished";
      lobby.winner = "draw";
      lobby.drawReason = getDrawReason(lobby.chess);
    }
    if (lobby.status === "finished") {
      log("Game finished (move)", { lobbyId, winner: lobby.winner, reason: lobby.winner === "draw" ? lobby.drawReason : "checkmate" });
    }
    saveLobby(lobby).catch(() => {});
    return {
      ok: true,
      fen: lobby.fen,
      move,
      winner: lobby.winner,
      status: lobby.status,
      drawReason: lobby.winner === "draw" ? lobby.drawReason : undefined,
      whiteTimeSec: lobby.whiteTimeSec,
      blackTimeSec: lobby.blackTimeSec,
    };
  } catch (e) {
    return { ok: false, reason: "invalid_move" };
  }
}

// REST API
app.get("/api/health", (_, res) => {
  log("GET /api/health");
  return res.json({ ok: true, name: "clawmate" });
});

// Status: counts only (no lobby IDs to avoid enumeration)
app.get("/api/status", (req, res) => {
  const all = Array.from(lobbies.values());
  const payload = {
    ok: true,
    totalLobbies: all.length,
    openLobbies: all.filter((l) => l.status === "waiting").length,
    byStatus: {
      waiting: all.filter((l) => l.status === "waiting").length,
      playing: all.filter((l) => l.status === "playing").length,
      finished: all.filter((l) => l.status === "finished").length,
      cancelled: all.filter((l) => l.status === "cancelled").length,
    },
  };
  log("GET /api/status", payload);
  res.json(payload);
});

app.post("/api/lobbies", async (req, res) => {
  const { message, signature, betAmount, contractGameId } = req.body || {};
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  if (!isSignatureFresh(message)) {
    return res.status(400).json({ error: "Signature expired or invalid timestamp" });
  }
  const player1Wallet = recoverAddress(message, signature);
  if (!player1Wallet) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  log("POST /api/lobbies", { player1Wallet: player1Wallet.slice(0, 10) + "…", betAmount, contractGameId });

  // Prevent creating a lobby if already in a playing game
  const activeGame = Array.from(lobbies.values()).find(
    (l) => l.status === "playing" && (l.player1Wallet?.toLowerCase() === player1Wallet || l.player2Wallet?.toLowerCase() === player1Wallet)
  );
  if (activeGame) {
    log("POST /api/lobbies 400 already in active game", { activeLobbyId: activeGame.lobbyId });
    return res.status(400).json({ error: "You are already in an active game. Finish or concede it first.", activeLobbyId: activeGame.lobbyId });
  }

  const existingInMemory = Array.from(lobbies.values()).find((l) => l.status === "waiting" && l.player1Wallet?.toLowerCase() === player1Wallet);
  if (existingInMemory) {
    log("POST /api/lobbies 400 already have lobby", { existingLobbyId: existingInMemory.lobbyId });
    return res.status(400).json({ error: "You already have an open lobby. Cancel it or wait for someone to join.", existingLobbyId: existingInMemory.lobbyId });
  }
  const existingInStore = await findWaitingLobbyByCreator(player1Wallet);
  if (existingInStore) {
    log("POST /api/lobbies 400 already have lobby (from store)", { existingLobbyId: existingInStore });
    return res.status(400).json({ error: "You already have an open lobby. Cancel it or wait for someone to join.", existingLobbyId: existingInStore });
  }
  const lobbyId = createLobby(player1Wallet, betAmount, contractGameId);
  const lobby = lobbies.get(lobbyId);
  res.status(201).json({
    lobbyId,
    contractGameId: lobby.contractGameId,
    betAmount: lobby.betAmount,
    player1Wallet: lobby.player1Wallet,
    player2Wallet: lobby.player2Wallet,
    fen: lobby.fen,
    status: lobby.status,
    winner: lobby.winner,
  });
});

app.get("/api/lobbies", async (req, res) => {
  const statusFilter = req.query.status; // "waiting" | "playing" | omit (default: waiting)
  const filter = statusFilter === "playing" ? (l) => l.status === "playing" : (l) => l.status === "waiting";
  let list = Array.from(lobbies.values())
    .filter(filter)
    .map((l) => ({
      lobbyId: l.lobbyId,
      betAmount: l.betAmount,
      contractGameId: l.contractGameId,
      player1Wallet: l.player1Wallet,
      ...(l.status === "playing"
        ? {
            player2Wallet: l.player2Wallet,
            fen: l.fen,
            status: l.status,
            winner: l.winner,
            ...(l.whiteTimeSec != null || l.blackTimeSec != null ? { whiteTimeSec: l.whiteTimeSec ?? null, blackTimeSec: l.blackTimeSec ?? null } : {}),
          }
        : {}),
    }));

  // Exclude any "waiting" lobby that is cancelled in the store (e.g. cancelled on another instance or by a previous request)
  if (statusFilter !== "playing" && list.length > 0) {
    const withStoreStatus = await Promise.all(
      list.map(async (item) => {
        const fromStore = await getLobbyFromStore(item.lobbyId);
        if (fromStore && fromStore.status === "cancelled") return null;
        return item;
      })
    );
    list = withStoreStatus.filter(Boolean);
  }

  log("GET /api/lobbies", { count: list.length, statusFilter: statusFilter ?? "waiting", lobbyIds: list.map((l) => l.lobbyId) });
  res.json({ lobbies: list });
});

app.get("/api/lobbies/:lobbyId", async (req, res) => {
  const { lobbyId } = req.params;
  if (!isValidLobbyId(lobbyId)) {
    return res.status(400).json({ error: "Invalid lobby id" });
  }
  let lobby = lobbies.get(lobbyId);
  if (!lobby) {
    const data = await getLobbyFromStore(lobbyId);
    if (data) {
      lobby = hydrateLobby(data, Chess);
      lobbies.set(lobbyId, lobby);
      log("GET /api/lobbies/:id loaded from store", { lobbyId });
    }
  }
  if (!lobby) {
    log("GET /api/lobbies/:id 404", { lobbyId });
    return res.status(404).json({ error: "Lobby not found" });
  }
  log("GET /api/lobbies/:id", { lobbyId, status: lobby.status });
  res.json({
    lobbyId: lobby.lobbyId,
    contractGameId: lobby.contractGameId,
    betAmount: lobby.betAmount,
    player1Wallet: lobby.player1Wallet,
    player2Wallet: lobby.player2Wallet,
    fen: lobby.fen,
    status: lobby.status,
    winner: lobby.winner,
    ...(lobby.winner === "draw" && lobby.drawReason ? { drawReason: lobby.drawReason } : {}),
    ...(lobby.status === "playing" && lobby.drawOfferBy ? { drawOfferBy: lobby.drawOfferBy } : {}),
    ...(lobby.status === "playing" && (lobby.whiteTimeSec != null || lobby.blackTimeSec != null) ? { whiteTimeSec: lobby.whiteTimeSec ?? null, blackTimeSec: lobby.blackTimeSec ?? null } : {}),
  });
});

app.post("/api/lobbies/:lobbyId/join", async (req, res) => {
  const { lobbyId } = req.params;
  if (!isValidLobbyId(lobbyId)) {
    return res.status(400).json({ error: "Invalid lobby id" });
  }
  const { message, signature } = req.body || {};
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  if (!isSignatureFresh(message)) {
    return res.status(400).json({ error: "Signature expired or invalid timestamp" });
  }
  const player2Wallet = recoverAddress(message, signature);
  if (!player2Wallet) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  log("POST /api/lobbies/:id/join", { lobbyId, player2Wallet: player2Wallet.slice(0, 10) + "…" });

  // Prevent joining if already in a playing game
  const activeGame = Array.from(lobbies.values()).find(
    (l) => l.status === "playing" && (l.player1Wallet?.toLowerCase() === player2Wallet || l.player2Wallet?.toLowerCase() === player2Wallet)
  );
  if (activeGame) {
    log("Join 400 already in active game", { activeLobbyId: activeGame.lobbyId });
    return res.status(400).json({ error: "You are already in an active game. Finish or concede it first.", activeLobbyId: activeGame.lobbyId });
  }

  // If lobby not in memory (e.g. created on another instance), try loading from store
  let lobby = lobbies.get(lobbyId);
  if (!lobby) {
    const data = await getLobbyFromStore(lobbyId);
    if (data) {
      lobby = hydrateLobby(data, Chess);
      lobbies.set(lobbyId, lobby);
      log("Join: loaded lobby from store", { lobbyId });
    }
  }

  if (!lobby) {
    log("Join 404 lobby not found", { lobbyId });
    return res.status(404).json({ error: "Lobby not found" });
  }
  if (lobby.status !== "waiting") {
    log("Join 400 lobby not waiting", { lobbyId, status: lobby.status });
    return res.status(400).json({ error: "Lobby is not open for joining" });
  }
  if (lobby.player2Wallet) {
    log("Join 400 lobby already has player", { lobbyId });
    return res.status(400).json({ error: "Lobby already has a player" });
  }

  const ok = joinLobby(lobbyId, player2Wallet);
  if (!ok) {
    log("Join 400 joinLobby failed", { lobbyId });
    return res.status(400).json({ error: "Cannot join lobby" });
  }
  lobby = lobbies.get(lobbyId);
  const startPayload = {
    player2Wallet,
    fen: lobby.fen,
    whiteTimeSec: lobby.whiteTimeSec ?? INITIAL_TIME_SEC,
    blackTimeSec: lobby.blackTimeSec ?? INITIAL_TIME_SEC,
  };
  io.to(lobbyId).emit("lobby_joined", startPayload);
  // Creator (White) may not be in room yet; send full game-start payload to wallet room so they can act immediately
  io.to(`wallet:${lobby.player1Wallet.toLowerCase()}`).emit("lobby_joined_yours", {
    lobbyId,
    player2Wallet,
    betAmount: lobby.betAmount,
    fen: lobby.fen,
    whiteTimeSec: lobby.whiteTimeSec ?? INITIAL_TIME_SEC,
    blackTimeSec: lobby.blackTimeSec ?? INITIAL_TIME_SEC,
  });
  res.json({ ok: true, fen: lobby.fen });
});

// Creator cancels waiting lobby (before opponent joins). Call after on-chain cancel to keep backend in sync.
app.post("/api/lobbies/:lobbyId/cancel", async (req, res) => {
  const { lobbyId } = req.params;
  if (!isValidLobbyId(lobbyId)) {
    return res.status(400).json({ error: "Invalid lobby id" });
  }
  let lobby = lobbies.get(lobbyId);
  const { message, signature } = req.body || {};
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  if (!isSignatureFresh(message)) {
    return res.status(400).json({ error: "Signature expired or invalid timestamp" });
  }
  const playerWallet = recoverAddress(message, signature);
  if (!playerWallet) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  log("POST /api/lobbies/:id/cancel", { lobbyId, playerWallet: playerWallet.slice(0, 10) + "…" });

  // If not in memory (e.g. different instance or restart), try loading from store so we can persist "cancelled"
  if (!lobby) {
    const data = await getLobbyFromStore(lobbyId);
    if (data && data.status === "waiting" && (data.player1Wallet || "").toLowerCase() === playerWallet) {
      await saveLobby({ ...data, status: "cancelled" });
      log("Lobby cancelled (from store)", { lobbyId });
      return res.json({ ok: true });
    }
    if (!data) {
      log("Cancel 404", { lobbyId });
      return res.status(404).json({ error: "Lobby not found" });
    }
    if ((data.player1Wallet || "").toLowerCase() !== playerWallet) {
      log("Cancel 403 not creator", { lobbyId });
      return res.status(403).json({ error: "Only the lobby creator can cancel" });
    }
    if (data.status !== "waiting") {
      log("Cancel 400 not waiting", { lobbyId, status: data.status });
      return res.status(400).json({ error: "Lobby is not waiting" });
    }
    return res.status(404).json({ error: "Lobby not found" });
  }

  if (lobby.player1Wallet?.toLowerCase() !== playerWallet) {
    log("Cancel 403 not creator", { lobbyId });
    return res.status(403).json({ error: "Only the lobby creator can cancel" });
  }
  if (lobby.status !== "waiting") {
    log("Cancel 400 not waiting", { lobbyId, status: lobby.status });
    return res.status(400).json({ error: "Lobby is not waiting" });
  }
  lobby.status = "cancelled";
  saveLobby(lobby).catch(() => {});
  log("Lobby cancelled", { lobbyId });
  res.json({ ok: true });
});

// Player concedes; other player wins. Backend updates state and optionally resolves escrow.
app.post("/api/lobbies/:lobbyId/concede", async (req, res) => {
  const { lobbyId } = req.params;
  if (!isValidLobbyId(lobbyId)) {
    return res.status(400).json({ error: "Invalid lobby id" });
  }
  let lobby = lobbies.get(lobbyId);
  if (!lobby) {
    const data = await getLobbyFromStore(lobbyId);
    if (data) {
      lobby = hydrateLobby(data, Chess);
      lobbies.set(lobbyId, lobby);
      log("Concede: loaded lobby from store", { lobbyId });
    }
  }
  const { message, signature } = req.body || {};
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  if (!isSignatureFresh(message)) {
    return res.status(400).json({ error: "Signature expired or invalid timestamp" });
  }
  const playerWallet = recoverAddress(message, signature);
  if (!playerWallet) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  log("POST /api/lobbies/:id/concede", { lobbyId, playerWallet: playerWallet.slice(0, 10) + "…" });
  if (!lobby) {
    log("Concede 404", { lobbyId });
    return res.status(404).json({ error: "Lobby not found" });
  }
  if (lobby.status !== "playing") {
    log("Concede 400 not playing", { lobbyId, status: lobby.status });
    return res.status(400).json({ error: "Game not in progress" });
  }
  const isP1 = lobby.player1Wallet?.toLowerCase() === playerWallet;
  const isP2 = lobby.player2Wallet?.toLowerCase() === playerWallet;
  if (!isP1 && !isP2) {
    log("Concede 403 not a player", { lobbyId });
    return res.status(403).json({ error: "Not a player in this game" });
  }
  lobby.status = "finished";
  lobby.winner = isP1 ? "black" : "white"; // other side wins
  saveLobby(lobby).catch(() => {});
  log("Game conceded", { lobbyId, winner: lobby.winner });
  const concedePayload = { fen: lobby.fen, winner: lobby.winner, status: "finished", concede: true };
  io.to(lobbyId).emit("move", concedePayload);
  const cp1 = lobby.player1Wallet?.toLowerCase();
  const cp2 = lobby.player2Wallet?.toLowerCase();
  if (cp1) io.to(`wallet:${cp1}`).emit("move", concedePayload);
  if (cp2) io.to(`wallet:${cp2}`).emit("move", concedePayload);
  resolveEscrowIfNeeded(lobby).catch(() => {});
  res.json({ ok: true, status: "finished", winner: lobby.winner });
});

// Resolve game (for backend/oracle to call contract: winner = player1Wallet | player2Wallet | null for draw)
app.get("/api/lobbies/:lobbyId/result", (req, res) => {
  const { lobbyId } = req.params;
  if (!isValidLobbyId(lobbyId)) {
    return res.status(400).json({ error: "Invalid lobby id" });
  }
  const lobby = lobbies.get(lobbyId);
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (lobby.status !== "finished") return res.json({ status: lobby.status, winner: null });
  log("GET /api/lobbies/:id/result", { lobbyId, winner: lobby.winner });
  const winnerAddress =
    lobby.winner === "white"
      ? lobby.player1Wallet
      : lobby.winner === "black"
        ? lobby.player2Wallet
        : null;
  const payload = {
    status: "finished",
    winner: lobby.winner,
    winnerAddress,
    ...(lobby.winner === "draw" && lobby.drawReason ? { drawReason: lobby.drawReason } : {}),
  };
  res.json(payload);
});

// ---------- Profile (username for leaderboard) ----------
// GET: public lookup by wallet. POST: set username (signed; profanity filtered).

app.get("/api/profile/username", async (req, res) => {
  const wallet = (req.query.wallet || "").trim();
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: "Valid wallet query required" });
  }
  const w = wallet.toLowerCase();
  let username = profiles.get(w) ?? null;
  if (username == null) {
    username = await getProfile(w);
    if (username != null) profiles.set(w, username);
  }
  res.json({ username });
});

app.post("/api/profile/username", async (req, res) => {
  const { message, signature, username: rawUsername } = req.body || {};
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  const wallet = recoverAddress(message, signature);
  if (!wallet) {
    return res.status(401).json({ error: "Invalid signature" });
  }
  if (!isSignatureFresh(message)) {
    return res.status(401).json({ error: "Signature expired or invalid" });
  }
  const signedUsername = extractUsernameFromMessage(message);
  const username = typeof rawUsername === "string" ? rawUsername.trim() : "";
  if (signedUsername !== username) {
    return res.status(400).json({ error: "Username in message must match request body" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Username must be 3–20 characters, letters, numbers, underscore, or hyphen" });
  }
  if (isProfane(username)) {
    return res.status(400).json({ error: "Username not allowed" });
  }
  profiles.set(wallet, username);
  await setProfile(wallet, username);
  log("Username set", { wallet, username });
  res.json({ ok: true, username });
});

// Leaderboard: aggregate PnL, wins, losses, draws for all wallets that have played a finished game.
app.get("/api/leaderboard", (req, res) => {
  const stats = {}; // wallet -> { wins, losses, draws, pnl }
  for (const lobby of lobbies.values()) {
    if (lobby.status !== "finished") continue;
    const p1 = lobby.player1Wallet?.toLowerCase();
    const p2 = lobby.player2Wallet?.toLowerCase();
    if (!p1 || !p2) continue;
    const bet = (() => { try { return BigInt(lobby.betAmount || "0"); } catch { return 0n; } })();
    if (!stats[p1]) stats[p1] = { wallet: lobby.player1Wallet, wins: 0, losses: 0, draws: 0, pnl: 0n };
    if (!stats[p2]) stats[p2] = { wallet: lobby.player2Wallet, wins: 0, losses: 0, draws: 0, pnl: 0n };
    if (lobby.winner === "white") {
      stats[p1].wins++;
      stats[p2].losses++;
      stats[p1].pnl += bet;
      stats[p2].pnl -= bet;
    } else if (lobby.winner === "black") {
      stats[p2].wins++;
      stats[p1].losses++;
      stats[p2].pnl += bet;
      stats[p1].pnl -= bet;
    } else {
      stats[p1].draws++;
      stats[p2].draws++;
    }
  }
  const leaderboard = Object.values(stats)
    .map((s) => {
      const w = (s.wallet || "").toLowerCase();
      return {
        wallet: s.wallet,
        username: profiles.get(w) ?? null,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        pnl: s.pnl.toString(),
      };
    })
    .sort((a, b) => {
      const diff = BigInt(b.pnl) - BigInt(a.pnl);
      if (diff !== 0n) return diff > 0n ? 1 : -1;
      return (b.wins - b.losses) - (a.wins - a.losses);
    });
  log("GET /api/leaderboard", { count: leaderboard.length });
  res.json({ leaderboard });
});

// Timeout: only the player who ran out of time can trigger (they sign; server sets winner to the other).
app.post("/api/lobbies/:lobbyId/timeout", (req, res) => {
  const { lobbyId } = req.params;
  if (!isValidLobbyId(lobbyId)) {
    return res.status(400).json({ error: "Invalid lobby id" });
  }
  const lobby = lobbies.get(lobbyId);
  const { message, signature } = req.body || {};
  if (!message || !signature) {
    return res.status(400).json({ error: "message and signature required" });
  }
  if (!isSignatureFresh(message)) {
    return res.status(400).json({ error: "Signature expired or invalid timestamp" });
  }
  const playerWhoTimedOut = recoverAddress(message, signature);
  if (!playerWhoTimedOut) {
    return res.status(400).json({ error: "Invalid signature" });
  }
  log("POST /api/lobbies/:id/timeout", { lobbyId, playerWhoTimedOut: playerWhoTimedOut.slice(0, 10) + "…" });
  if (!lobby) return res.status(404).json({ error: "Lobby not found" });
  if (lobby.status !== "playing") return res.status(400).json({ error: "Game not in progress" });
  const isP1 = lobby.player1Wallet?.toLowerCase() === playerWhoTimedOut;
  const isP2 = lobby.player2Wallet?.toLowerCase() === playerWhoTimedOut;
  if (!isP1 && !isP2) {
    return res.status(403).json({ error: "Not a player in this game" });
  }
  // Player who timed out loses; other wins.
  lobby.status = "finished";
  lobby.winner = isP1 ? "black" : "white";
  saveLobby(lobby).catch(() => {});
  log("Game finished (timeout)", { lobbyId, winner: lobby.winner });
  const timeoutPayload = { fen: lobby.fen, winner: lobby.winner, status: "finished" };
  io.to(lobbyId).emit("move", timeoutPayload);
  const tp1 = lobby.player1Wallet?.toLowerCase();
  const tp2 = lobby.player2Wallet?.toLowerCase();
  if (tp1) io.to(`wallet:${tp1}`).emit("move", timeoutPayload);
  if (tp2) io.to(`wallet:${tp2}`).emit("move", timeoutPayload);
  resolveEscrowIfNeeded(lobby).catch(() => {});
  res.json({ ok: true, status: "finished", winner: lobby.winner });
});

// Socket.io: real-time moves (wallet-bound auth)
io.on("connection", (socket) => {
  log("Socket connected", { socketId: socket.id });

  socket.on("register_wallet", (payload) => {
    const message = payload?.message;
    const signature = payload?.signature;
    if (!message || !signature) {
      socket.emit("register_wallet_error", { reason: "message and signature required" });
      return;
    }
    if (!isSignatureFresh(message)) {
      socket.emit("register_wallet_error", { reason: "Signature expired or invalid timestamp" });
      return;
    }
    const wallet = recoverAddress(message, signature);
    if (!wallet) {
      socket.emit("register_wallet_error", { reason: "Invalid signature" });
      return;
    }
    socket.join(`wallet:${wallet}`);
    socketToWallet.set(socket.id, wallet);
    log("Socket register_wallet", { socketId: socket.id, wallet: wallet.slice(0, 10) + "…" });
  });

  socket.on("join_lobby", async (lobbyId) => {
    if (!isValidLobbyId(lobbyId)) {
      socket.emit("join_lobby_error", { reason: "Invalid lobby id" });
      return;
    }
    const wallet = socketToWallet.get(socket.id);
    let lobby = lobbies.get(lobbyId);
    if (!lobby) {
      const data = await getLobbyFromStore(lobbyId);
      if (data) {
        lobby = hydrateLobby(data, Chess);
        lobbies.set(lobbyId, lobby);
        log("Socket join_lobby: loaded lobby from store", { lobbyId });
      }
    }
    if (!lobby) {
      socket.emit("join_lobby_error", { reason: "Lobby not found" });
      return;
    }
    const pw = wallet?.toLowerCase();
    const isP1 = lobby.player1Wallet?.toLowerCase() === pw;
    const isP2 = lobby.player2Wallet?.toLowerCase() === pw;
    if (!isP1 && !isP2) {
      socket.emit("join_lobby_error", { reason: "Not a player in this lobby" });
      return;
    }
    socket.join(lobbyId);
    gameToLobby.set(socket.id, lobbyId);
    log("Socket join_lobby", { socketId: socket.id, lobbyId });
  });

  socket.on("leave_lobby", (lobbyId) => {
    socket.leave(lobbyId);
    if (gameToLobby.get(socket.id) === lobbyId) gameToLobby.delete(socket.id);
  });

  socket.on("spectate_lobby", (lobbyId) => {
    if (!isValidLobbyId(lobbyId)) {
      socket.emit("spectate_error", { reason: "Invalid lobby id" });
      return;
    }
    const lobby = lobbies.get(lobbyId);
    if (!lobby) {
      socket.emit("spectate_error", { reason: "Lobby not found" });
      return;
    }
    socket.join(lobbyId);
    log("Socket spectate_lobby", { socketId: socket.id, lobbyId });
    socket.emit("game_state", {
      fen: lobby.fen,
      status: lobby.status,
      winner: lobby.winner,
      ...(lobby.winner === "draw" && lobby.drawReason ? { reason: lobby.drawReason } : {}),
      ...(lobby.status === "playing" && lobby.drawOfferBy ? { drawOfferBy: lobby.drawOfferBy } : {}),
    });
  });

  socket.on("move", ({ lobbyId, from, to, promotion }) => {
    if (!isValidLobbyId(lobbyId)) {
      socket.emit("move_error", { reason: "invalid_lobby" });
      return;
    }
    const wallet = socketToWallet.get(socket.id);
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.status !== "playing") {
      socket.emit("move_error", { reason: "invalid_lobby" });
      return;
    }
    const turn = (lobby.fen || "").split(" ")[1] || "w";
    const currentPlayerWallet = turn === "w" ? lobby.player1Wallet?.toLowerCase() : lobby.player2Wallet?.toLowerCase();
    if (wallet !== currentPlayerWallet) {
      log("Socket move rejected (not your turn)", { socketId: socket.id, lobbyId });
      socket.emit("move_error", { reason: "not_your_turn" });
      return;
    }
    const result = applyMove(lobbyId, from, to, promotion || "q");
    if (result.ok) {
      saveLobby(lobby).catch(() => {});
      if (result.status === "finished" && lobby) resolveEscrowIfNeeded(lobby).catch(() => {});
      log("Socket move", { lobbyId, from, to: to || promotion, status: result.status, winner: result.winner ?? null });
      const movePayload = {
        from: result.move.from,
        to: result.move.to,
        fen: result.fen,
        winner: result.winner,
        status: result.status,
        ...(result.winner === "draw" && result.drawReason ? { reason: result.drawReason } : {}),
        ...(result.whiteTimeSec != null || result.blackTimeSec != null ? { whiteTimeSec: result.whiteTimeSec, blackTimeSec: result.blackTimeSec } : {}),
      };
      // Emit to lobby room (primary) + both wallet rooms (fallback so players don't miss events if not in room)
      io.to(lobbyId).emit("move", movePayload);
      const p1w = lobby.player1Wallet?.toLowerCase();
      const p2w = lobby.player2Wallet?.toLowerCase();
      if (p1w) io.to(`wallet:${p1w}`).emit("move", movePayload);
      if (p2w) io.to(`wallet:${p2w}`).emit("move", movePayload);
    } else {
      log("Socket move rejected", { lobbyId, from, to, reason: result.reason });
      socket.emit("move_error", { reason: result.reason });
    }
  });

  /** Get player color for a wallet in a lobby. Returns "white" | "black" | null. */
  function getPlayerColor(lobby, wallet) {
    if (!lobby || !wallet) return null;
    const w = wallet.toLowerCase();
    if (lobby.player1Wallet?.toLowerCase() === w) return "white";
    if (lobby.player2Wallet?.toLowerCase() === w) return "black";
    return null;
  }

  socket.on("offer_draw", (lobbyId) => {
    if (!isValidLobbyId(lobbyId)) return;
    const wallet = socketToWallet.get(socket.id);
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.status !== "playing") {
      socket.emit("draw_error", { reason: "invalid_lobby" });
      return;
    }
    const color = getPlayerColor(lobby, wallet);
    if (!color) {
      socket.emit("draw_error", { reason: "not_a_player" });
      return;
    }
    lobby.drawOfferBy = color;
    saveLobby(lobby).catch(() => {});
    log("Draw offered", { lobbyId, by: color });
    io.to(lobbyId).emit("draw_offered", { by: color });
  });

  socket.on("accept_draw", async (lobbyId) => {
    if (!isValidLobbyId(lobbyId)) return;
    const wallet = socketToWallet.get(socket.id);
    let lobby = lobbies.get(lobbyId);
    if (!lobby) {
      const data = await getLobbyFromStore(lobbyId);
      if (data) {
        lobby = hydrateLobby(data, Chess);
        lobbies.set(lobbyId, lobby);
        log("accept_draw: loaded lobby from store", { lobbyId });
      }
    }
    if (!lobby || lobby.status !== "playing") {
      socket.emit("draw_error", { reason: "invalid_lobby" });
      return;
    }
    const color = getPlayerColor(lobby, wallet);
    if (!color) {
      socket.emit("draw_error", { reason: "not_a_player" });
      return;
    }
    // Accept only if the *other* side offered (opponent offered)
    if (lobby.drawOfferBy !== (color === "white" ? "black" : "white")) {
      socket.emit("draw_error", { reason: "no_draw_offer" });
      return;
    }
    lobby.status = "finished";
    lobby.winner = "draw";
    lobby.drawReason = "agreement";
    lobby.drawOfferBy = null;
    saveLobby(lobby).catch(() => {});
    resolveEscrowIfNeeded(lobby).catch(() => {});
    log("Draw accepted (agreement)", { lobbyId });
    const drawPayload = { fen: lobby.fen, winner: "draw", status: "finished", reason: "agreement" };
    io.to(lobbyId).emit("move", drawPayload);
    const dp1 = lobby.player1Wallet?.toLowerCase();
    const dp2 = lobby.player2Wallet?.toLowerCase();
    if (dp1) io.to(`wallet:${dp1}`).emit("move", drawPayload);
    if (dp2) io.to(`wallet:${dp2}`).emit("move", drawPayload);
  });

  socket.on("decline_draw", (lobbyId) => {
    if (!isValidLobbyId(lobbyId)) return;
    const wallet = socketToWallet.get(socket.id);
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.status !== "playing") return;
    const color = getPlayerColor(lobby, wallet);
    if (!color) return;
    // Decline: the player who *received* the offer (the other side) declines
    if (lobby.drawOfferBy !== (color === "white" ? "black" : "white")) return;
    lobby.drawOfferBy = null;
    saveLobby(lobby).catch(() => {});
    log("Draw declined", { lobbyId });
    io.to(lobbyId).emit("draw_declined");
  });

  socket.on("withdraw_draw", (lobbyId) => {
    if (!isValidLobbyId(lobbyId)) return;
    const wallet = socketToWallet.get(socket.id);
    const lobby = lobbies.get(lobbyId);
    if (!lobby || lobby.status !== "playing") return;
    const color = getPlayerColor(lobby, wallet);
    if (!color) return;
    if (lobby.drawOfferBy !== color) return; // only offerer can withdraw
    lobby.drawOfferBy = null;
    saveLobby(lobby).catch(() => {});
    log("Draw offer withdrawn", { lobbyId });
    io.to(lobbyId).emit("draw_declined");
  });

  socket.on("disconnect", (reason) => {
    const lobbyId = gameToLobby.get(socket.id);
    log("Socket disconnect", { socketId: socket.id, lobbyId: lobbyId ?? null, reason });
    gameToLobby.delete(socket.id);
    socketToWallet.delete(socket.id);
  });
});

// Server-side clock: every second, decrement the side-to-move's time; if <= 0, declare timeout.
function tickClocks() {
  for (const [lobbyId, lobby] of lobbies.entries()) {
    if (lobby.status !== "playing" || !lobby.fen) continue;
    const turn = lobby.fen.split(" ")[1] || "w";
    const whiteSec = lobby.whiteTimeSec ?? INITIAL_TIME_SEC;
    const blackSec = lobby.blackTimeSec ?? INITIAL_TIME_SEC;
    if (turn === "w") {
      lobby.whiteTimeSec = Math.max(0, whiteSec - 1);
      if (lobby.whiteTimeSec <= 0) {
        lobby.status = "finished";
        lobby.winner = "black";
        lobby.whiteTimeSec = 0;
        saveLobby(lobby).catch(() => {});
        log("Game finished (timeout)", { lobbyId, winner: lobby.winner });
        const payload = { fen: lobby.fen, winner: "black", status: "finished", whiteTimeSec: 0, blackTimeSec: blackSec, timeout: true };
        io.to(lobbyId).emit("move", payload);
        const p1w = lobby.player1Wallet?.toLowerCase();
        const p2w = lobby.player2Wallet?.toLowerCase();
        if (p1w) io.to(`wallet:${p1w}`).emit("move", payload);
        if (p2w) io.to(`wallet:${p2w}`).emit("move", payload);
        resolveEscrowIfNeeded(lobby).catch(() => {});
      }
    } else {
      lobby.blackTimeSec = Math.max(0, blackSec - 1);
      if (lobby.blackTimeSec <= 0) {
        lobby.status = "finished";
        lobby.winner = "white";
        lobby.blackTimeSec = 0;
        saveLobby(lobby).catch(() => {});
        log("Game finished (timeout)", { lobbyId, winner: lobby.winner });
        const payload = { fen: lobby.fen, winner: "white", status: "finished", whiteTimeSec: whiteSec, blackTimeSec: 0, timeout: true };
        io.to(lobbyId).emit("move", payload);
        const p1w = lobby.player1Wallet?.toLowerCase();
        const p2w = lobby.player2Wallet?.toLowerCase();
        if (p1w) io.to(`wallet:${p1w}`).emit("move", payload);
        if (p2w) io.to(`wallet:${p2w}`).emit("move", payload);
        resolveEscrowIfNeeded(lobby).catch(() => {});
      }
    }
  }
}

// Auto-cancel stale waiting lobbies (no opponent joined within STALE_LOBBY_TTL_MS).
const STALE_LOBBY_TTL_MS = 30 * 60 * 1000; // 30 minutes
function cleanupStaleLobbies() {
  const now = Date.now();
  for (const [lobbyId, lobby] of lobbies.entries()) {
    if (lobby.status !== "waiting") continue;
    const age = now - (lobby.createdAt ?? now);
    if (age > STALE_LOBBY_TTL_MS) {
      lobby.status = "cancelled";
      saveLobby(lobby).catch(() => {});
      log("Auto-cancelled stale lobby", { lobbyId, ageMin: Math.round(age / 60000) });
    }
  }
}

async function start() {
  await initStore();
  await loadLobbies(lobbies, Chess);
  await loadProfiles(profiles);
  setInterval(tickClocks, 1000);
  setInterval(cleanupStaleLobbies, 60 * 1000); // check every minute
  cleanupStaleLobbies(); // run once on startup
  http.listen(PORT, "0.0.0.0", () => {
    log(`Server listening on 0.0.0.0:${PORT}`);
    log("Escrow resolver", { enabled: !!escrowContract });
    log("Persistence", { mongo: !!process.env.MONGODB_URI, redis: !!process.env.REDIS_URL });
  });
}
start().catch((err) => {
  logErr("Startup failed", err);
  process.exit(1);
});

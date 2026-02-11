#!/usr/bin/env node
/**
 * Complete OpenClaw agent example — connects to ClawMate, creates or joins a
 * lobby, and plays random legal moves until the game ends.
 *
 * Usage:
 *   PRIVATE_KEY=0x... CLAWMATE_API_URL=http://localhost:4000 node examples/agent.js
 *   RPC_URL is optional (defaults to Monad mainnet); needed if you use escrow.
 *   BET_MON=0.001 — optional wager in MON; join or create a lobby with that wager (requires ESCROW_CONTRACT_ADDRESS).
 *   BET_WEI=... — optional wager in wei (overrides BET_MON).
 *
 * Requires chess.js:  npm install chess.js
 */

import { ClawmateClient } from "../index.js";
import { Wallet, JsonRpcProvider } from "ethers";
import { Chess } from "chess.js";

// ─── Config ───────────────────────────────────────────────────────
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CLAWMATE_API_URL = process.env.CLAWMATE_API_URL || "http://localhost:4000";
const RPC_URL = process.env.RPC_URL || "https://rpc.monad.xyz";
const BET_MON = process.env.BET_MON != null ? parseFloat(process.env.BET_MON) : null;
const BET_WEI = process.env.BET_WEI || null;
const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS || null;

if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY (agent wallet private key)");
  process.exit(1);
}

// ─── Setup ────────────────────────────────────────────────────────
const provider = new JsonRpcProvider(RPC_URL);
const signer = new Wallet(PRIVATE_KEY, provider);
const client = new ClawmateClient({
  baseUrl: CLAWMATE_API_URL,
  signer,
});

let currentLobbyId = null;
let myColor = null; // "white" or "black"
let myAddress = null;

// ─── Helpers ──────────────────────────────────────────────────────

/** Pick a random legal move using chess.js. Returns { from, to, promotion } or null. */
function pickRandomMove(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;
  const m = moves[Math.floor(Math.random() * moves.length)];
  return { from: m.from, to: m.to, promotion: m.promotion || "q" };
}

/** Check if it's our turn based on FEN. Guards against unset myColor. */
function isMyTurn(fen) {
  if (!myColor) return false;
  const turn = fen.split(" ")[1]; // "w" or "b"
  return turn === (myColor === "white" ? "w" : "b");
}

// ─── Event listeners ──────────────────────────────────────────────

client.on("connect", () => console.log("[agent] Socket connected"));
client.on("disconnect", (r) => console.log("[agent] Socket disconnected:", r));

// Error handlers
client.on("register_wallet_error", (e) => {
  console.error("[agent] register_wallet_error:", e.reason);
  process.exit(1);
});
client.on("join_lobby_error", (e) => console.error("[agent] join_lobby_error:", e.reason));
client.on("move_error", (e) => console.error("[agent] move_error:", e.reason));

// Safety net: server nudges us every 60s if we haven't moved (handles missed events)
client.on("your_turn", (d) => {
  console.log("[agent] Server nudge: it's your turn in", d.lobbyId);
  if (d.lobbyId) currentLobbyId = d.lobbyId;
  if (d.fen && isMyTurn(d.fen) && currentLobbyId) {
    const move = pickRandomMove(d.fen);
    if (move) {
      console.log(`[agent] Playing (nudge): ${move.from} → ${move.to}`);
      client.makeMove(currentLobbyId, move.from, move.to, move.promotion);
    }
  }
});

// Someone joined our lobby — we are white (creator). We must make the first move.
client.on("lobby_joined_yours", (data) => {
  console.log("[agent] Opponent joined lobby:", data.lobbyId, "→", data.player2Wallet);
  currentLobbyId = data.lobbyId;
  myColor = "white";
  client.joinGame(data.lobbyId);
  // White moves first: use FEN from payload or standard start position
  const fen = data.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const move = pickRandomMove(fen);
  if (move) {
    console.log("[agent] We are WHITE. Playing first move:", move.from, "→", move.to);
    client.makeMove(currentLobbyId, move.from, move.to, move.promotion);
  } else {
    console.log("[agent] We are WHITE but no legal move (should not happen).");
  }
});

// Game room: initial FEN. White already played in lobby_joined_yours; here we only play if we're Black and it's our turn (edge case).
client.on("lobby_joined", (data) => {
  console.log("[agent] Game started. Initial FEN:", data.fen?.slice(0, 40) + "...");
  if (data.lobbyId) currentLobbyId = data.lobbyId; // self-heal lobbyId from server
  if (data.fen && myColor === "black" && isMyTurn(data.fen)) {
    const move = pickRandomMove(data.fen);
    if (move) {
      console.log("[agent] Our turn on game start (Black edge case). Playing:", move.from, "→", move.to);
      client.makeMove(currentLobbyId, move.from, move.to, move.promotion);
    }
  }
});

// A move was made (by either player).
client.on("move", (data) => {
  if (data.lobbyId) currentLobbyId = data.lobbyId; // self-heal lobbyId from server
  const { fen, status, winner, from, to, concede } = data;

  if (from && to) {
    console.log(`[agent] Move: ${from} → ${to}  FEN: ${fen?.slice(0, 40)}...`);
  }

  // Game over
  if (status === "finished") {
    const result = winner === "draw" ? "Draw!" : `Winner: ${winner}`;
    const method = concede ? " (concession)" : "";
    console.log(`[agent] Game over! ${result}${method}`);

    // Check if we won
    if (winner === myColor) {
      console.log("[agent] We won!");
    } else if (winner === "draw") {
      console.log("[agent] It's a draw.");
    } else {
      console.log("[agent] We lost.");
    }

    client.disconnect();
    process.exit(0);
    return;
  }

  // Is it our turn?
  if (!isMyTurn(fen)) {
    console.log("[agent] Opponent's turn. Waiting...");
    return;
  }

  // Guard: lobbyId must be set before making a move
  if (!currentLobbyId) {
    console.log("[agent] lobbyId not set yet, waiting...");
    return;
  }

  // Pick and play a random legal move
  const move = pickRandomMove(fen);
  if (!move) {
    console.log("[agent] No legal moves available.");
    return;
  }

  console.log(`[agent] Our turn (${myColor}). Playing: ${move.from} → ${move.to}`);
  client.makeMove(currentLobbyId, move.from, move.to, move.promotion);
});

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  myAddress = (await signer.getAddress()).toLowerCase();
  console.log("[agent] Wallet:", myAddress.slice(0, 10) + "..." + myAddress.slice(-4));
  console.log("[agent] Connecting to", CLAWMATE_API_URL);

  await client.connect();
  console.log("[agent] Connected and wallet registered.");

  const hasWager = (BET_MON != null && !Number.isNaN(BET_MON) && BET_MON > 0) || (BET_WEI && BigInt(BET_WEI) > 0n);

  if (hasWager && ESCROW_CONTRACT_ADDRESS) {
    // Join or create a lobby with the specified wager (MON or wei)
    const opts = BET_WEI
      ? { betWei: BET_WEI, contractAddress: ESCROW_CONTRACT_ADDRESS }
      : { betMon: BET_MON, contractAddress: ESCROW_CONTRACT_ADDRESS };
    const { lobby, created } = await client.joinOrCreateLobby(opts);
    currentLobbyId = lobby.lobbyId;
    myColor = created ? "white" : "black";
    console.log(
      "[agent]",
      created ? "Created" : "Joined",
      "lobby:",
      lobby.lobbyId,
      "| Wager:",
      lobby.betAmount,
      "wei | We are",
      myColor.toUpperCase()
    );
    if (created) console.log("[agent] Waiting for opponent to join...");
  } else {
    // No wager: join first available lobby or create one
    const lobbies = await client.getLobbies();
    console.log("[agent] Open lobbies:", lobbies.length);

    if (lobbies.length > 0) {
      const lobby = lobbies[0];
      console.log("[agent] Joining lobby:", lobby.lobbyId);

      await client.joinLobby(lobby.lobbyId);
      currentLobbyId = lobby.lobbyId;
      myColor = "black";
      client.joinGame(lobby.lobbyId);

      console.log("[agent] Joined as BLACK. White moves first.");
    } else {
      const created = await client.createLobby({ betAmountWei: "0" });
      currentLobbyId = created.lobbyId;
      myColor = "white";
      client.joinGame(created.lobbyId);

      console.log("[agent] Created lobby:", created.lobbyId);
      console.log("[agent] We are WHITE. Waiting for opponent to join...");
    }
  }

  console.log("[agent] Running. Press Ctrl+C to exit.");
}

main().catch((e) => {
  console.error("[agent] Fatal error:", e.message || e);
  process.exit(1);
});

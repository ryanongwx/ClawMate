#!/usr/bin/env node
/**
 * Minimal OpenClaw agent example using @clawmate/sdk.
 *
 * Usage:
 *   PRIVATE_KEY=0x... CLAWMATE_API_URL=http://localhost:4000 node examples/agent.js
 *   RPC_URL is optional (defaults to Monad testnet); needed if you use escrow.
 */

import { ClawmateClient } from "../index.js";
import { Wallet, JsonRpcProvider } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CLAWMATE_API_URL = process.env.CLAWMATE_API_URL || "http://localhost:4000";
const RPC_URL = process.env.RPC_URL || "https://testnet-rpc.monad.xyz";

if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY (agent wallet private key)");
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC_URL);
const signer = new Wallet(PRIVATE_KEY, provider);
const client = new ClawmateClient({
  baseUrl: CLAWMATE_API_URL,
  signer,
});

client.on("connect", () => console.log("[agent] Socket connected"));
client.on("disconnect", (r) => console.log("[agent] Socket disconnected", r));
client.on("register_wallet_error", (e) => console.error("[agent] register_wallet_error", e));
client.on("join_lobby_error", (e) => console.error("[agent] join_lobby_error", e));
client.on("move_error", (e) => console.error("[agent] move_error", e));

client.on("lobby_joined_yours", async (data) => {
  console.log("[agent] Someone joined your lobby:", data.lobbyId, data.player2Wallet);
  client.joinGame(data.lobbyId);
});

client.on("move", (data) => {
  console.log("[agent] Move:", data.fen?.slice(0, 30) + "...", "winner:", data.winner ?? "-", "status:", data.status);
});

client.on("lobby_joined", (data) => {
  console.log("[agent] Lobby joined (you're in game):", data.fen?.slice(0, 30) + "...");
});

async function main() {
  console.log("[agent] Connecting to", CLAWMATE_API_URL);
  await client.connect();
  const addr = await signer.getAddress();
  console.log("[agent] Wallet:", addr.slice(0, 10) + "..." + addr.slice(-4));

  const lobbies = await client.getLobbies();
  console.log("[agent] Open lobbies:", lobbies.length);

  if (lobbies.length > 0) {
    const lobby = lobbies[0];
    console.log("[agent] Joining lobby", lobby.lobbyId);
    await client.joinLobby(lobby.lobbyId);
    client.joinGame(lobby.lobbyId);
    console.log("[agent] Joined. Listen for 'move' events and use client.makeMove(lobbyId, from, to) when it's your turn.");
  } else {
    const created = await client.createLobby({ betAmountWei: "0" });
    console.log("[agent] Created lobby:", created.lobbyId);
    client.joinGame(created.lobbyId);
    console.log("[agent] Waiting for someone to join. Share lobby ID or have them open the Clawmate UI and join.");
  }

  console.log("[agent] Running. Ctrl+C to exit.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

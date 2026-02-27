import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

// Lazy-loaded Anchor IDL for the chess_bet_escrow program.
// You must place the generated IDL JSON at this path after building the Solana program:
//   backend/chess_bet_escrow_idl.json
// If it's missing, Solana resolution will simply log an error and skip.
let idlPromise = null;
async function loadIdl() {
  if (!idlPromise) {
    idlPromise = import("./chess_bet_escrow_idl.json", { assert: { type: "json" } }).then(
      (m) => m.default ?? m
    );
  }
  return idlPromise;
}

const PROGRAM_ID_STR = process.env.SOLANA_ESCROW_PROGRAM_ID;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL;
const SOLANA_RESOLVER_SECRET_KEY = process.env.SOLANA_RESOLVER_SECRET_KEY;

let program = null;
let resolverKeypair = null;
let configPda = null;

async function initSolanaProgramOnce(log, logErr) {
  if (program) return program;
  if (!PROGRAM_ID_STR || !SOLANA_RPC_URL || !SOLANA_RESOLVER_SECRET_KEY) {
    return null;
  }

  try {
    const idl = await loadIdl();
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");

    // Expect SOLANA_RESOLVER_SECRET_KEY as JSON array (preferred) or base58 string.
    let kp;
    try {
      const parsed = JSON.parse(SOLANA_RESOLVER_SECRET_KEY);
      const secret = Uint8Array.from(parsed);
      kp = Keypair.fromSecretKey(secret);
    } catch {
      const { default: bs58 } = await import("bs58");
      const secret = bs58.decode(SOLANA_RESOLVER_SECRET_KEY);
      kp = Keypair.fromSecretKey(secret);
    }
    resolverKeypair = kp;

    const wallet = new anchor.Wallet(resolverKeypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      preflightCommitment: "confirmed",
    });
    const programId = new PublicKey(PROGRAM_ID_STR);
    program = new anchor.Program(idl, programId, provider);

    // Derive config PDA once (seed "config")
    const [cfg] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId
    );
    configPda = cfg;

    log("Solana escrow resolver init", {
      programId: PROGRAM_ID_STR,
      resolver: resolverKeypair.publicKey.toBase58(),
      rpc: SOLANA_RPC_URL,
    });

    return program;
  } catch (e) {
    logErr("Solana escrow init failed", e);
    program = null;
    return null;
  }
}

function getGamePda(gameId) {
  if (!program || !configPda) {
    throw new Error("Solana program not initialized");
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("game"),
      configPda.toBuffer(),
      new anchor.BN(gameId).toArrayLike(Buffer, "le", 8),
    ],
    program.programId
  );
  return pda;
}

/**
 * Resolve escrow for a finished lobby on Solana.
 * - No-ops if SOLANA_* env vars are not set or IDL/program is unavailable.
 * - winner: "white" | "black" | "draw" (mapped from lobby.winner).
 * - Uses lobby.player1Wallet / lobby.player2Wallet as SOL addresses.
 */
export async function resolveSolanaEscrowIfNeeded(lobby, log, logErr) {
  if (!PROGRAM_ID_STR || !SOLANA_RPC_URL || !SOLANA_RESOLVER_SECRET_KEY) return;
  if (!lobby || lobby.status !== "finished" || lobby.contractGameId == null) return;

  const gameId =
    typeof lobby.contractGameId === "string"
      ? parseInt(lobby.contractGameId, 10)
      : lobby.contractGameId;
  if (Number.isNaN(gameId) || gameId < 1) {
    logErr("Solana resolveGame invalid gameId", {
      contractGameId: lobby.contractGameId,
    });
    return;
  }

  const winnerColor = lobby.winner; // "white" | "black" | "draw"
  let winnerPubkey = null;
  try {
    if (winnerColor === "white") {
      if (!lobby.player1Wallet) throw new Error("missing player1Wallet");
      winnerPubkey = new PublicKey(lobby.player1Wallet);
    } else if (winnerColor === "black") {
      if (!lobby.player2Wallet) throw new Error("missing player2Wallet");
      winnerPubkey = new PublicKey(lobby.player2Wallet);
    } else {
      winnerPubkey = null; // draw -> default pubkey
    }
  } catch (e) {
    logErr("Solana resolveGame invalid winner pubkey", e);
    return;
  }

  try {
    await initSolanaProgramOnce(log, logErr);
    if (!program) return;

    const gamePda = getGamePda(gameId);
    const game = await program.account.game.fetch(gamePda);

    const winnerArg = winnerPubkey ?? PublicKey.default;

    log("Solana Escrow resolveGame", {
      lobbyId: lobby.lobbyId,
      contractGameId: gameId,
      winner: winnerColor,
      winnerPubkey: winnerArg.toBase58(),
    });

    await program.methods
      .resolveGame(winnerArg)
      .accounts({
        config: configPda,
        game: gamePda,
        caller: resolverKeypair.publicKey,
        player1: game.player1,
        player2: game.player2,
        winnerAccount: winnerPubkey ?? game.player1, // any valid account if draw
      })
      .signers([resolverKeypair])
      .rpc();

    log("Solana Escrow resolveGame ok", {
      lobbyId: lobby.lobbyId,
      contractGameId: gameId,
    });
  } catch (e) {
    logErr("Solana Escrow resolveGame failed", e);
  }
}


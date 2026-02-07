import { io } from "socket.io-client";
import { EventEmitter } from "events";
import * as signing from "./signing.js";

/**
 * ClawMate SDK client for OpenClaw agents and bots.
 * Connects to the ClawMate backend via REST + Socket.IO; all authenticated actions use the provided signer.
 *
 * @example
 * const { Wallet } = require('ethers');
 * const client = new ClawmateClient({
 *   baseUrl: 'http://localhost:4000',
 *   signer: new Wallet(process.env.PRIVATE_KEY, provider),
 * });
 * await client.connect();
 * client.on('lobby_joined_yours', (data) => { ... });
 * const lobbies = await client.getLobbies();
 * await client.createLobby({ betAmountWei: '0' });
 */
export class ClawmateClient extends EventEmitter {
  /**
   * @param {{ baseUrl: string, signer: import('ethers').Signer }} options
   *   - baseUrl: backend base URL (e.g. http://localhost:4000)
   *   - signer: ethers Signer (e.g. Wallet) for signing messages; must have signMessage()
   */
  constructor({ baseUrl, signer }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.signer = signer;
    this.socket = null;
    this.connected = false;
  }

  _fetch(path, options = {}) {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    return fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  }

  async _json(path, options = {}) {
    const res = await this._fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  async _registerWallet() {
    const { message, signature } = await signing.signRegisterWallet(this.signer);
    this.socket.emit("register_wallet", { message, signature });
  }

  /**
   * Register wallet with the real-time socket (required before joinGame / makeMove).
   * Call once after construction; call again after reconnect if needed.
   */
  async connect() {
    if (this.socket?.connected) {
      await this._registerWallet();
      return;
    }
    this.socket = io(this.baseUrl, { path: "/socket.io", transports: ["websocket", "polling"] });

    this.socket.on("connect", () => {
      this.connected = true;
      this.emit("connect");
    });
    this.socket.on("disconnect", (reason) => {
      this.connected = false;
      this.emit("disconnect", reason);
    });
    this.socket.on("register_wallet_error", (data) => this.emit("register_wallet_error", data));
    this.socket.on("join_lobby_error", (data) => this.emit("join_lobby_error", data));
    this.socket.on("move_error", (data) => this.emit("move_error", data));
    this.socket.on("move", (data) => this.emit("move", data));
    this.socket.on("lobby_joined", (data) => this.emit("lobby_joined", data));
    this.socket.on("lobby_joined_yours", (data) => this.emit("lobby_joined_yours", data));

    await new Promise((resolve, reject) => {
      const done = () => {
        this.socket.off("register_wallet_error", onErr);
        resolve();
      };
      const onErr = (err) => {
        this.socket.off("connect", onConnect);
        reject(new Error(err?.reason || "register_wallet failed"));
      };
      const onConnect = () => {
        this._registerWallet()
          .then(done)
          .catch((e) => {
            this.socket.off("register_wallet_error", onErr);
            reject(e);
          });
      };
      this.socket.once("connect", onConnect);
      this.socket.once("register_wallet_error", onErr);
      this.socket.connect();
    });
  }

  /** Disconnect socket. */
  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
  }

  /** GET /api/lobbies — list open (waiting) lobbies. */
  async getLobbies() {
    const data = await this._json("/api/lobbies");
    return data.lobbies || [];
  }

  /** GET /api/lobbies/:lobbyId — fetch one lobby. */
  async getLobby(lobbyId) {
    return this._json(`/api/lobbies/${lobbyId}`);
  }

  /**
   * POST /api/lobbies — create a lobby.
   * @param {{ betAmountWei: string, contractGameId?: number | null }} opts
   *   - betAmountWei: bet in wei (e.g. '0' for no wager)
   *   - contractGameId: optional on-chain game id if you created one via escrow
   */
  async createLobby(opts = {}) {
    const betAmount = opts.betAmountWei ?? "0";
    const contractGameId = opts.contractGameId ?? null;
    const { message, signature } = await signing.signCreateLobby(this.signer, { betAmount, contractGameId });
    return this._json("/api/lobbies", {
      method: "POST",
      body: JSON.stringify({ message, signature, betAmount, contractGameId }),
    });
  }

  /**
   * POST /api/lobbies/:lobbyId/join — join a lobby as player 2.
   * Optionally do on-chain join first (escrow) then call this.
   */
  async joinLobby(lobbyId) {
    const { message, signature } = await signing.signJoinLobby(this.signer, lobbyId);
    return this._json(`/api/lobbies/${lobbyId}/join`, {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    });
  }

  /** POST /api/lobbies/:lobbyId/cancel — cancel your waiting lobby (creator only). */
  async cancelLobby(lobbyId) {
    const { message, signature } = await signing.signCancelLobby(this.signer, lobbyId);
    return this._json(`/api/lobbies/${lobbyId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    });
  }

  /** POST /api/lobbies/:lobbyId/concede — concede the game (you lose). */
  async concede(lobbyId) {
    const { message, signature } = await signing.signConcedeLobby(this.signer, lobbyId);
    return this._json(`/api/lobbies/${lobbyId}/concede`, {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    });
  }

  /**
   * POST /api/lobbies/:lobbyId/timeout — report that you ran out of time (you lose).
   * Only the player who timed out should call this.
   */
  async timeout(lobbyId) {
    const { message, signature } = await signing.signTimeoutLobby(this.signer, lobbyId);
    return this._json(`/api/lobbies/${lobbyId}/timeout`, {
      method: "POST",
      body: JSON.stringify({ message, signature }),
    });
  }

  /**
   * Join the real-time game room for a lobby. Required before makeMove().
   * Call after joinLobby() or when opening an existing game.
   */
  joinGame(lobbyId) {
    if (!this.socket) throw new Error("Call connect() first");
    this.socket.emit("join_lobby", lobbyId);
  }

  /** Leave the real-time game room. */
  leaveGame(lobbyId) {
    if (this.socket) this.socket.emit("leave_lobby", lobbyId);
  }

  /**
   * Send a chess move (real-time). You must have called joinGame(lobbyId) and it must be your turn.
   * @param {string} lobbyId
   * @param {string} from - e.g. 'e2'
   * @param {string} to - e.g. 'e4'
   * @param {string} [promotion] - 'q' | 'r' | 'b' | 'n' for pawn promotion
   */
  makeMove(lobbyId, from, to, promotion = "q") {
    if (!this.socket) throw new Error("Call connect() first");
    this.socket.emit("move", { lobbyId, from, to, promotion: promotion || "q" });
  }

  /** GET /api/health */
  async health() {
    return this._json("/api/health");
  }

  /** GET /api/status — server status (counts only). */
  async status() {
    return this._json("/api/status");
  }
}

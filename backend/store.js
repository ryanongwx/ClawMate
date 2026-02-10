/**
 * Optional persistence for lobbies. If MONGODB_URI is set, lobbies are stored in MongoDB.
 * If REDIS_URL is set (and not MONGODB_URI), lobbies are stored in Redis.
 * Otherwise in-memory only. Restarts lose state unless a store is configured.
 */

const ts = () => new Date().toISOString();
const log = (msg, data = null) => {
  const out = data != null ? `[${ts()}] [store] ${msg} ${JSON.stringify(data)}` : `[${ts()}] [store] ${msg}`;
  console.log(out);
};

function serializeLobby(lobby) {
  return {
    lobbyId: lobby.lobbyId,
    contractGameId: lobby.contractGameId ?? null,
    betAmount: lobby.betAmount ? String(lobby.betAmount) : "0",
    player1Wallet: lobby.player1Wallet || null,
    player2Wallet: lobby.player2Wallet || null,
    fen: lobby.fen || null,
    status: lobby.status || "waiting",
    winner: lobby.winner ?? null,
    drawReason: lobby.drawReason ?? null,
    whiteTimeSec: lobby.whiteTimeSec ?? null,
    blackTimeSec: lobby.blackTimeSec ?? null,
    createdAt: lobby.createdAt ?? Date.now(),
  };
}

const DEFAULT_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Store mode: "mongo" | "redis" | null (in-memory)
let storeMode = null;
let mongoClient = null;
let mongoCollection = null;
let mongoProfilesCollection = null;
let redis = null;

const REDIS_PREFIX = "clawmate:lobby:";
const REDIS_IDS_KEY = "clawmate:lobby_ids";
const REDIS_PROFILE_PREFIX = "clawmate:profile:";
const MONGO_DB_NAME = "clawmate";
const MONGO_COLLECTION = "lobbies";
const MONGO_PROFILES_COLLECTION = "profiles";

export async function initStore() {
  const mongoUri = process.env.MONGODB_URI;
  const redisUrl = process.env.REDIS_URL;

  if (mongoUri) {
    try {
      const { MongoClient } = await import("mongodb");
      mongoClient = new MongoClient(mongoUri);
      await mongoClient.connect();
      const db = mongoClient.db(MONGO_DB_NAME);
      mongoCollection = db.collection(MONGO_COLLECTION);
      mongoProfilesCollection = db.collection(MONGO_PROFILES_COLLECTION);
      storeMode = "mongo";
      log("MongoDB connected");
    } catch (e) {
      console.warn("[store] MongoDB not available:", e.message);
    }
  }

  if (storeMode === null && redisUrl) {
    try {
      const Redis = (await import("ioredis")).default;
      redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
      redis.on("error", (err) => console.error("[store] Redis error", err?.message));
      storeMode = "redis";
      log("Redis connected");
    } catch (e) {
      console.warn("[store] Redis not available:", e.message);
    }
  }

  if (storeMode === null) {
    log("No MONGODB_URI or REDIS_URL; using in-memory only");
  }
}

/**
 * Load a single lobby from the store by id. Returns raw lobby data (no Chess instance).
 * Used when a join request hits an instance that doesn't have the lobby in memory (e.g. lobby was created on another instance).
 * @param {string} lobbyId
 * @returns {Promise<object | null>} Raw lobby data or null
 */
export async function getLobbyFromStore(lobbyId) {
  if (!lobbyId) return null;
  if (storeMode === "mongo" && mongoCollection) {
    try {
      const doc = await mongoCollection.findOne({ lobbyId });
      if (!doc) return null;
      return { ...doc, _id: undefined };
    } catch (e) {
      console.warn("[store] getLobbyFromStore (MongoDB) failed", lobbyId, e.message);
      return null;
    }
  }
  if (storeMode === "redis" && redis) {
    try {
      const raw = await redis.get(REDIS_PREFIX + lobbyId);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.warn("[store] getLobbyFromStore (Redis) failed", lobbyId, e.message);
      return null;
    }
  }
  return null;
}

/**
 * Find a waiting lobby whose creator is the given wallet (case-insensitive).
 * Used to enforce "one open lobby per user" when using a store (multi-instance or after restart).
 * @param {string} wallet - Creator wallet (player1Wallet)
 * @returns {Promise<string | null>} lobbyId if found, else null
 */
export async function findWaitingLobbyByCreator(wallet) {
  if (!wallet || typeof wallet !== "string") return null;
  const w = wallet.toLowerCase();
  if (storeMode === "mongo" && mongoCollection) {
    try {
      const escaped = wallet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const doc = await mongoCollection.findOne(
        { status: "waiting", player1Wallet: new RegExp(`^${escaped}$`, "i") },
        { projection: { lobbyId: 1 } }
      );
      return doc?.lobbyId ?? null;
    } catch (e) {
      console.warn("[store] findWaitingLobbyByCreator (MongoDB) failed", e.message);
      return null;
    }
  }
  if (storeMode === "redis" && redis) {
    try {
      const ids = await redis.smembers(REDIS_IDS_KEY);
      for (const id of ids) {
        const raw = await redis.get(REDIS_PREFIX + id);
        if (!raw) continue;
        try {
          const data = JSON.parse(raw);
          if (data.status === "waiting" && (data.player1Wallet || "").toLowerCase() === w) return id;
        } catch (_) {}
      }
      return null;
    } catch (e) {
      console.warn("[store] findWaitingLobbyByCreator (Redis) failed", e.message);
      return null;
    }
  }
  return null;
}

/**
 * Hydrate raw lobby data into a full lobby object (with Chess instance). Exported for use in server when loading a single lobby.
 * @param {object} data - Raw lobby data from store
 * @param {typeof import('chess.js')} Chess - Chess constructor
 * @returns {object} Lobby object with chess, fen
 */
export function hydrateLobby(data, Chess) {
  const fen = data.fen || DEFAULT_FEN;
  const chess = new Chess(fen);
  return {
    ...data,
    chess,
    fen: data.fen || chess.fen(),
  };
}

/**
 * Load all lobbies from the active store into the given Map. Reconstructs Chess from fen.
 * @param {Map} lobbies - Map to fill (lobbyId -> lobby object with chess)
 * @param {typeof import('chess.js')} Chess - Chess constructor
 */
export async function loadLobbies(lobbies, Chess) {
  if (storeMode === "mongo" && mongoCollection) {
    try {
      const cursor = mongoCollection.find({});
      for await (const doc of cursor) {
        try {
          const data = { ...doc, _id: undefined };
          const id = data.lobbyId;
          if (!id) continue;
          lobbies.set(id, hydrateLobby(data, Chess));
        } catch (e) {
          console.warn("[store] Skip invalid lobby", doc?.lobbyId, e.message);
        }
      }
      log("Loaded lobbies from MongoDB", { count: lobbies.size });
    } catch (e) {
      console.error("[store] loadLobbies (MongoDB) failed", e.message);
    }
    return;
  }

  if (storeMode === "redis" && redis) {
    try {
      const ids = await redis.smembers(REDIS_IDS_KEY);
      for (const id of ids) {
        const raw = await redis.get(REDIS_PREFIX + id);
        if (!raw) continue;
        try {
          const data = JSON.parse(raw);
          lobbies.set(id, hydrateLobby(data, Chess));
        } catch (e) {
          console.warn("[store] Skip invalid lobby", id, e.message);
        }
      }
      log("Loaded lobbies from Redis", { count: lobbies.size });
    } catch (e) {
      console.error("[store] loadLobbies (Redis) failed", e.message);
    }
  }
}

/**
 * Persist a lobby to the active store. Call after any mutation.
 * @param {object} lobby - Lobby object (with fen; chess not serialized)
 */
export async function saveLobby(lobby) {
  if (!lobby?.lobbyId) return;
  const data = serializeLobby(lobby);

  if (storeMode === "mongo" && mongoCollection) {
    try {
      await mongoCollection.updateOne(
        { lobbyId: lobby.lobbyId },
        { $set: data },
        { upsert: true }
      );
    } catch (e) {
      console.error("[store] saveLobby (MongoDB) failed", lobby.lobbyId, e.message);
    }
    return;
  }

  if (storeMode === "redis" && redis) {
    try {
      await redis.set(REDIS_PREFIX + lobby.lobbyId, JSON.stringify(data));
      await redis.sadd(REDIS_IDS_KEY, lobby.lobbyId);
    } catch (e) {
      console.error("[store] saveLobby (Redis) failed", lobby.lobbyId, e.message);
    }
  }
}

/** For backward compatibility and cleanup; prefer loadLobbies. */
export async function loadLobbiesFromRedis(lobbies, Chess) {
  return loadLobbies(lobbies, Chess);
}

// ---------- Profiles (wallet -> username for leaderboard) ----------

/**
 * Get username for a wallet from the store.
 * @param {string} wallet - Address (lowercase recommended)
 * @returns {Promise<string | null>}
 */
export async function getProfile(wallet) {
  if (!wallet || typeof wallet !== "string") return null;
  const w = wallet.toLowerCase();
  if (storeMode === "mongo" && mongoProfilesCollection) {
    try {
      const doc = await mongoProfilesCollection.findOne({ wallet: w }, { projection: { username: 1 } });
      return doc?.username ?? null;
    } catch (e) {
      console.warn("[store] getProfile (MongoDB) failed", e.message);
      return null;
    }
  }
  if (storeMode === "redis" && redis) {
    try {
      const raw = await redis.get(REDIS_PROFILE_PREFIX + w);
      return raw ?? null;
    } catch (e) {
      console.warn("[store] getProfile (Redis) failed", e.message);
      return null;
    }
  }
  return null;
}

/**
 * Set username for a wallet. Persists when using MongoDB or Redis.
 * @param {string} wallet - Address (lowercase recommended)
 * @param {string} username - Display name
 */
export async function setProfile(wallet, username) {
  if (!wallet || typeof wallet !== "string" || typeof username !== "string") return;
  const w = wallet.toLowerCase();
  const trimmed = username.trim();
  if (storeMode === "mongo" && mongoProfilesCollection) {
    try {
      await mongoProfilesCollection.updateOne(
        { wallet: w },
        { $set: { wallet: w, username: trimmed, updatedAt: Date.now() } },
        { upsert: true }
      );
    } catch (e) {
      console.error("[store] setProfile (MongoDB) failed", e.message);
    }
    return;
  }
  if (storeMode === "redis" && redis) {
    try {
      await redis.set(REDIS_PROFILE_PREFIX + w, trimmed);
    } catch (e) {
      console.error("[store] setProfile (Redis) failed", e.message);
    }
  }
}

/**
 * Load all wallet -> username pairs into the given Map. Used at server startup when using a store.
 * @param {Map<string, string>} profilesMap - Map to fill (wallet lowercase -> username)
 */
export async function loadProfiles(profilesMap) {
  if (!profilesMap || typeof profilesMap.set !== "function") return;
  if (storeMode === "mongo" && mongoProfilesCollection) {
    try {
      const cursor = mongoProfilesCollection.find({}, { projection: { wallet: 1, username: 1 } });
      for await (const doc of cursor) {
        if (doc.wallet && doc.username) profilesMap.set(doc.wallet.toLowerCase(), doc.username);
      }
      log("Loaded profiles from MongoDB", { count: profilesMap.size });
    } catch (e) {
      console.error("[store] loadProfiles (MongoDB) failed", e.message);
    }
    return;
  }
  if (storeMode === "redis" && redis) {
    try {
      const keys = await redis.keys(REDIS_PROFILE_PREFIX + "*");
      for (const key of keys) {
        const wallet = key.slice(REDIS_PROFILE_PREFIX.length);
        const username = await redis.get(key);
        if (wallet && username) profilesMap.set(wallet.toLowerCase(), username);
      }
      log("Loaded profiles from Redis", { count: profilesMap.size });
    } catch (e) {
      console.error("[store] loadProfiles (Redis) failed", e.message);
    }
  }
}

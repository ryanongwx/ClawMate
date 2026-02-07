import { Contract, BrowserProvider } from "ethers";

const ESCROW_ADDRESS = import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS || "";

const ESCROW_ABI = [
  "function createLobby() external payable",
  "function joinLobby(uint256 gameId) external payable",
  "function cancelLobby(uint256 gameId) external",
  "function games(uint256) view returns (address player1, address player2, uint256 betAmount, bool active, address winner)",
  "event LobbyCreated(uint256 gameId, address player1, uint256 betAmount)",
  "event LobbyJoined(uint256 gameId, address player2)",
  "event LobbyCancelled(uint256 gameId, address player1)",
];

export function getEscrowAddress() {
  return ESCROW_ADDRESS || null;
}

export function hasEscrow() {
  return Boolean(ESCROW_ADDRESS);
}

/**
 * Get escrow contract instance. Needs a signer (wallet) for createLobby/joinLobby.
 * @param {import('ethers').BrowserProvider | import('ethers').Signer} signerOrProvider - signer for sending tx, or provider for read-only
 * @returns {import('ethers').Contract | null}
 */
export function getEscrowContract(signerOrProvider) {
  if (!ESCROW_ADDRESS || !signerOrProvider) return null;
  return new Contract(ESCROW_ADDRESS, ESCROW_ABI, signerOrProvider);
}

/**
 * Create lobby on-chain: user signs tx to send bet to escrow. Returns contract gameId or null.
 * @param {string} betWei - bet amount in wei (bigint or string)
 * @returns {Promise<number | null>} contract gameId (1-based) or null on skip/failure
 */
export async function createLobbyOnChain(betWei) {
  const amount = BigInt(betWei);
  if (amount <= 0n || !hasEscrow()) return null;
  if (!window.ethereum) throw new Error("Wallet not found");
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const contract = getEscrowContract(signer);
  if (!contract) return null;
  const tx = await contract.createLobby({ value: amount });
  const receipt = await tx.wait();
  const event = receipt?.logs?.find((log) => {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      return parsed?.name === "LobbyCreated";
    } catch {
      return false;
    }
  });
  if (event) {
    const parsed = contract.interface.parseLog({ topics: event.topics, data: event.data });
    return Number(parsed.args.gameId);
  }
  return null;
}

/**
 * Join lobby on-chain: user signs tx to send bet to escrow.
 * @param {number} contractGameId - game id on contract (1-based)
 * @param {string | bigint} betWei - bet amount in wei
 * @returns {Promise<boolean>} true if tx succeeded
 */
export async function joinLobbyOnChain(contractGameId, betWei) {
  if (!contractGameId || !hasEscrow()) return false;
  const amount = BigInt(betWei);
  if (amount <= 0n) return false;
  if (!window.ethereum) throw new Error("Wallet not found");
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const contract = getEscrowContract(signer);
  if (!contract) return false;
  const tx = await contract.joinLobby(contractGameId, { value: amount });
  await tx.wait();
  return true;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Read game state from contract (no tx). Returns null if contract not configured or read fails.
 * @param {number} contractGameId - game id on contract (1-based)
 * @returns {Promise<{ active: boolean, player1: string, player2: string, betAmount: string } | null>}
 */
export async function getGameStateOnChain(contractGameId) {
  if (!contractGameId || !hasEscrow()) return null;
  if (!window.ethereum) return null;
  try {
    const provider = new BrowserProvider(window.ethereum);
    const contract = getEscrowContract(provider);
    if (!contract) return null;
    const g = await contract.games(contractGameId);
    const player1 = g?.player1 ?? g?.[0];
    const player2 = g?.player2 ?? g?.[1];
    const betAmount = g?.betAmount ?? g?.[2];
    const active = g?.active ?? g?.[3];
    if (player1 == null) return null;
    return {
      active: Boolean(active),
      player1: (player1 || ZERO_ADDRESS).toLowerCase(),
      player2: (player2 || ZERO_ADDRESS).toLowerCase(),
      betAmount: betAmount != null ? String(betAmount) : "0",
    };
  } catch {
    return null;
  }
}

/**
 * Get contract balance in wei (for debugging refund failures).
 * @returns {Promise<bigint | null>}
 */
export async function getContractBalance() {
  if (!hasEscrow() || !window.ethereum) return null;
  try {
    const provider = new BrowserProvider(window.ethereum);
    return await provider.getBalance(ESCROW_ADDRESS);
  } catch {
    return null;
  }
}

/**
 * Turn contract/revert errors into a short user-facing message.
 */
function toCancelErrorMessage(e) {
  const msg = e?.reason ?? e?.shortMessage ?? e?.message ?? "";
  if (msg.includes("Only creator can cancel")) return "Only the lobby creator can cancel.";
  if (msg.includes("Lobby already has opponent")) return "Someone already joined; you cannot cancel.";
  if (msg.includes("Game not active")) return "This lobby was already cancelled on-chain.";
  if (msg.includes("missing revert data") || msg.includes("CALL_EXCEPTION") || e?.code === "CALL_EXCEPTION") {
    return "Cancel failed on-chain. Check that you're the creator, no one has joined, and you're on the correct network. If you already cancelled, refresh the page.";
  }
  if (msg.includes("user rejected") || msg.includes("rejected")) return "Transaction was rejected.";
  return msg || "Cancel failed. Check your network and try again.";
}

const isMissingRevertData = (e) =>
  (e?.code === "CALL_EXCEPTION") ||
  (typeof e?.message === "string" && e.message.includes("missing revert data"));

/**
 * Cancel lobby on-chain (creator only, no opponent yet). Refunds creator.
 * Retries once with explicit gas limit if the first attempt fails with missing revert data (some RPCs).
 * @param {number} contractGameId - game id on contract (1-based)
 * @returns {Promise<boolean>} true if tx succeeded
 */
export async function cancelLobbyOnChain(contractGameId) {
  if (!contractGameId || !hasEscrow()) return false;
  if (!window.ethereum) throw new Error("Wallet not found");
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const contract = getEscrowContract(signer);
  if (!contract) return false;
  const run = async (opts = {}) => {
    const tx = await contract.cancelLobby(contractGameId, opts);
    await tx.wait();
    return true;
  };
  try {
    return await run();
  } catch (e) {
    if (isMissingRevertData(e)) {
      try {
        return await run({ gasLimit: 200_000 });
      } catch (retryErr) {
        throw new Error(toCancelErrorMessage(retryErr));
      }
    }
    throw new Error(toCancelErrorMessage(e));
  }
}

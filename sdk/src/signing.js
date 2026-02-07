/**
 * Message builders and signing for ClawMate API/Socket auth.
 * Uses EIP-191 personal_sign; backend recovers address and validates timestamp.
 */

const DOMAIN = "ClawMate";

/**
 * @param {import('ethers').Signer} signer
 * @param {string} message
 * @returns {Promise<string>} signature hex
 */
export async function signMessage(signer, message) {
  return signer.signMessage(message);
}

function buildCreateLobbyMessage(betAmount, contractGameId) {
  const timestamp = Date.now();
  return `${DOMAIN} create lobby\nBet: ${betAmount}\nContractGameId: ${contractGameId ?? ""}\nTimestamp: ${timestamp}`;
}

function buildJoinLobbyMessage(lobbyId) {
  const timestamp = Date.now();
  return `${DOMAIN} join lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
}

function buildCancelLobbyMessage(lobbyId) {
  const timestamp = Date.now();
  return `${DOMAIN} cancel lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
}

function buildConcedeLobbyMessage(lobbyId) {
  const timestamp = Date.now();
  return `${DOMAIN} concede lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
}

function buildTimeoutLobbyMessage(lobbyId) {
  const timestamp = Date.now();
  return `${DOMAIN} timeout lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
}

function buildRegisterWalletMessage() {
  const timestamp = Date.now();
  return `${DOMAIN} register wallet\nTimestamp: ${timestamp}`;
}

/**
 * @param {import('ethers').Signer} signer
 * @param {{ betAmount: string, contractGameId?: number | null }} opts
 */
export async function signCreateLobby(signer, opts) {
  const message = buildCreateLobbyMessage(opts.betAmount, opts.contractGameId ?? null);
  const signature = await signMessage(signer, message);
  return { message, signature };
}

/** @param {import('ethers').Signer} signer @param {string} lobbyId */
export async function signJoinLobby(signer, lobbyId) {
  const message = buildJoinLobbyMessage(lobbyId);
  const signature = await signMessage(signer, message);
  return { message, signature };
}

/** @param {import('ethers').Signer} signer @param {string} lobbyId */
export async function signCancelLobby(signer, lobbyId) {
  const message = buildCancelLobbyMessage(lobbyId);
  const signature = await signMessage(signer, message);
  return { message, signature };
}

/** @param {import('ethers').Signer} signer @param {string} lobbyId */
export async function signConcedeLobby(signer, lobbyId) {
  const message = buildConcedeLobbyMessage(lobbyId);
  const signature = await signMessage(signer, message);
  return { message, signature };
}

/** @param {import('ethers').Signer} signer @param {string} lobbyId */
export async function signTimeoutLobby(signer, lobbyId) {
  const message = buildTimeoutLobbyMessage(lobbyId);
  const signature = await signMessage(signer, message);
  return { message, signature };
}

/** @param {import('ethers').Signer} signer */
export async function signRegisterWallet(signer) {
  const message = buildRegisterWalletMessage();
  const signature = await signMessage(signer, message);
  return { message, signature };
}

import { BrowserProvider } from "ethers";

const DOMAIN = "Clawmate";

/**
 * Sign a message with the connected wallet. Uses personal_sign (EIP-191).
 * @param {string} message - Plain text message to sign
 * @returns {Promise<string>} Signature hex string
 */
export async function signMessage(message) {
  if (!window.ethereum) throw new Error("No wallet found");
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  return signer.signMessage(message);
}

/**
 * Build and sign create-lobby message. Backend recovers player1Wallet from signature.
 */
export async function signCreateLobby({ betAmount, contractGameId }) {
  const timestamp = Date.now();
  const message = `${DOMAIN} create lobby\nBet: ${betAmount}\nContractGameId: ${contractGameId ?? ""}\nTimestamp: ${timestamp}`;
  const signature = await signMessage(message);
  return { message, signature };
}

/**
 * Build and sign join-lobby message. Backend recovers player2Wallet from signature.
 */
export async function signJoinLobby(lobbyId) {
  const timestamp = Date.now();
  const message = `${DOMAIN} join lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
  const signature = await signMessage(message);
  return { message, signature };
}

/**
 * Build and sign cancel-lobby message. Backend verifies signer is creator.
 */
export async function signCancelLobby(lobbyId) {
  const timestamp = Date.now();
  const message = `${DOMAIN} cancel lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
  const signature = await signMessage(message);
  return { message, signature };
}

/**
 * Build and sign concede message. Backend verifies signer is a player.
 */
export async function signConcedeLobby(lobbyId) {
  const timestamp = Date.now();
  const message = `${DOMAIN} concede lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
  const signature = await signMessage(message);
  return { message, signature };
}

/**
 * Build and sign timeout message. Signer = player who ran out of time (loser). Backend sets winner to the other.
 */
export async function signTimeoutLobby(lobbyId) {
  const timestamp = Date.now();
  const message = `${DOMAIN} timeout lobby\nLobbyId: ${lobbyId}\nTimestamp: ${timestamp}`;
  const signature = await signMessage(message);
  return { message, signature };
}

/**
 * Build and sign register_wallet for Socket.IO. Proves ownership of wallet so server can bind socket to address.
 */
export async function signRegisterWallet() {
  const timestamp = Date.now();
  const message = `${DOMAIN} register wallet\nTimestamp: ${timestamp}`;
  const signature = await signMessage(message);
  return { message, signature };
}

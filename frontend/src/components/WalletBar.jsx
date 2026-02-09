import React, { useState } from "react";

// Network config — defaults to Monad Mainnet (chain ID 143 / 0x8f).
// Override with VITE_CHAIN_ID, VITE_RPC_URL, etc. at build time for testnet or other networks.
const CHAIN_ID = import.meta.env.VITE_CHAIN_ID || "0x8f"; // Monad Mainnet 143
const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.monad.xyz";
const CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || "Monad";
const BLOCK_EXPLORER_URL = import.meta.env.VITE_BLOCK_EXPLORER_URL || "https://explorer.monad.xyz";

export default function WalletBar({ wallet, setWallet }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const connect = async () => {
    if (!window.ethereum) {
      setError("No wallet found. Install a compatible wallet to play.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      if (chainId !== CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: CHAIN_ID }],
          });
        } catch (e) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: CHAIN_ID,
              chainName: CHAIN_NAME,
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: [BLOCK_EXPLORER_URL],
            }],
          });
        }
      }
      setWallet(accounts[0]);
    } catch (e) {
      setError(e.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => setWallet(null);

  return (
    <div className="wallet-bar">
      {error && <span className="wallet-error">{error}</span>}
      {wallet ? (
        <>
          <span className="wallet-addr">{wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
          <button type="button" className="btn btn-ghost" onClick={disconnect}>Disconnect</button>
        </>
      ) : (
        <button type="button" className="btn" onClick={connect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
      )}
    </div>
  );
}

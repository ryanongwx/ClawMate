import React, { useState } from "react";

const MONAD_CHAIN_ID = "0x279F"; // Monad Testnet chain ID 10143 (0x279F = 10143)
const MONAD_RPC = "https://testnet-rpc.monad.xyz";

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
      if (chainId !== MONAD_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: MONAD_CHAIN_ID }],
          });
        } catch (e) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: MONAD_CHAIN_ID,
              chainName: "Monad Testnet",
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: [MONAD_RPC],
              blockExplorerUrls: ["https://testnet.monad.xyz"],
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

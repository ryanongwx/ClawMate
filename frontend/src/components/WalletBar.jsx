import React, { useState, useEffect } from "react";

// Network config — defaults to Monad Mainnet (chain ID 143 / 0x8f).
// Override with VITE_CHAIN_ID, VITE_RPC_URL, etc. at build time for testnet or other networks.
const CHAIN_ID = import.meta.env.VITE_CHAIN_ID || "0x8f"; // Monad Mainnet 143
const RPC_URL = import.meta.env.VITE_RPC_URL || "https://rpc.monad.xyz";
const CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || "Monad";
const BLOCK_EXPLORER_URL = import.meta.env.VITE_BLOCK_EXPLORER_URL || "https://explorer.monad.xyz";

const WALLET_STORAGE_KEY = "clawmate_wallet";

export default function WalletBar({ wallet, setWallet }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Restore wallet from localStorage on load (no popup; only reconnects if wallet is still unlocked/connected)
  useEffect(() => {
    if (wallet) return;
    const stored = (() => {
      try {
        return localStorage.getItem(WALLET_STORAGE_KEY);
      } catch {
        return null;
      }
    })();
    if (!stored || !window.ethereum) return;
    window.ethereum
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        if (!accounts?.length) return;
        const lower = stored.toLowerCase();
        const found = accounts.find((a) => a.toLowerCase() === lower);
        if (found) setWallet(found);
        else try {
          localStorage.removeItem(WALLET_STORAGE_KEY);
        } catch (_) {}
      })
      .catch(() => {
        try {
          localStorage.removeItem(WALLET_STORAGE_KEY);
        } catch (_) {}
      });
  }, []);

  // Sync when user switches account in wallet (e.g. MetaMask)
  useEffect(() => {
    if (!window.ethereum?.on) return;
    const onAccountsChanged = (accounts) => {
      if (!accounts?.length) {
        setWallet(null);
        try {
          localStorage.removeItem(WALLET_STORAGE_KEY);
        } catch (_) {}
      } else {
        setWallet(accounts[0]);
        try {
          localStorage.setItem(WALLET_STORAGE_KEY, accounts[0]);
        } catch (_) {}
      }
    };
    window.ethereum.on("accountsChanged", onAccountsChanged);
    return () => {
      window.ethereum.off?.("accountsChanged", onAccountsChanged);
    };
  }, []);

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
      const account = accounts[0];
      setWallet(account);
      try {
        if (account) localStorage.setItem(WALLET_STORAGE_KEY, account);
      } catch (_) {}
    } catch (e) {
      setError(e.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    setWallet(null);
    try {
      localStorage.removeItem(WALLET_STORAGE_KEY);
    } catch (_) {}
  };

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

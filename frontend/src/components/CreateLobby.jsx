import React, { useState } from "react";
import { parseEther } from "ethers";
import { api } from "../lib/api";
import { hasEscrow, createLobbyOnChain } from "../lib/escrow";
import { signCreateLobby } from "../lib/auth";

export default function CreateLobby({ wallet, rulesAccepted, onShowRules, onCreated, onBack }) {
  const [betAmount, setBetAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [existingLobbyId, setExistingLobbyId] = useState(null);

  const create = async () => {
    if (!wallet) return;
    if (!rulesAccepted) {
      onShowRules?.();
      return;
    }
    setLoading(true);
    setError(null);
    setExistingLobbyId(null);
    try {
      const betMon = betAmount?.trim() || "0";
      let betWei = "0";
      try {
        betWei = String(parseEther(betMon));
      } catch {
        setError("Invalid amount. Use a number (e.g. 0.001 or 1).");
        setLoading(false);
        return;
      }
      let contractGameId = null;
      if (hasEscrow() && BigInt(betWei) > 0n) {
        contractGameId = await createLobbyOnChain(betWei);
        if (contractGameId == null) {
          setError("Transaction failed or was rejected");
          setLoading(false);
          return;
        }
      }
      const { message, signature } = await signCreateLobby({ betAmount: betWei, contractGameId });
      const res = await api("/api/lobbies", {
        method: "POST",
        body: JSON.stringify({
          message,
          signature,
          betAmount: betWei,
          contractGameId,
        }),
      });
      const data = await res.json();
      if (res.ok && data?.lobbyId) {
        onCreated(data.lobbyId, data);
      } else {
        setError(data?.error || "Failed to create lobby");
        if (data?.existingLobbyId) setExistingLobbyId(data.existingLobbyId);
      }
    } catch (e) {
      setError(e?.reason || e?.message || "Request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="create-lobby create-lobby-page">
      <button type="button" className="btn btn-back" onClick={onBack}>
        ← Back
      </button>

      {!rulesAccepted && (
        <div className="create-lobby-rules-gate" role="alert">
          <p>You must accept the FIDE rules before creating a lobby.</p>
          <button type="button" className="btn btn-rules-inline" onClick={onShowRules}>
            View &amp; accept rules
          </button>
        </div>
      )}
      <div className="create-lobby-header">
        <h1 className="create-lobby-title">Create lobby</h1>
        <p className="create-lobby-subtitle">
          Set a bet amount in MON. Others can join by matching the same bet.
        </p>
      </div>

      <div className="create-lobby-card">
        <div className="create-lobby-card-icon">♟</div>
        <div className="form-group">
          <label htmlFor="bet-amount">Bet amount (MON)</label>
          <input
            id="bet-amount"
            type="text"
            value={betAmount}
            onChange={(e) => setBetAmount(e.target.value)}
            placeholder="0.001"
            className="create-lobby-input"
          />
          <span className="form-hint">Use 0 or leave empty for no on-chain wager (test games).</span>
        </div>
        {error && (
          <div className="create-lobby-error" role="alert">
            <p>{error}</p>
            {existingLobbyId && (
              <button
                type="button"
                className="btn btn-go-to-lobby"
                onClick={async () => {
                  try {
                    const r = await api(`/api/lobbies/${existingLobbyId}`);
                    const data = await r.json();
                    if (r.ok) onCreated(existingLobbyId, data);
                  } catch (_) {}
                }}
              >
                Go to my lobby
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className="btn btn-create-lobby"
          onClick={create}
          disabled={!wallet || !rulesAccepted || loading}
        >
          {loading ? "Creating…" : "Create lobby"}
        </button>
      </div>
    </section>
  );
}

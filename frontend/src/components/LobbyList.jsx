import React, { useState, useEffect } from "react";
import { formatEther } from "ethers";
import { api } from "../lib/api";
import { hasEscrow, joinLobbyOnChain, cancelLobbyOnChain, getGameStateOnChain, getContractBalance } from "../lib/escrow";
import { signJoinLobby, signCancelLobby } from "../lib/auth";

function betWeiToMon(weiStr) {
  if (!weiStr || weiStr === "0") return "0";
  try {
    return formatEther(weiStr);
  } catch {
    return weiStr;
  }
}

/** Get fullmove number from FEN (6th field). 1-based; 1 = after white's first move. */
function getTurnCount(fen) {
  if (!fen || typeof fen !== "string") return 0;
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 6) return 0;
  const n = parseInt(parts[5], 10);
  return Number.isNaN(n) ? 0 : n;
}

const TAB_OPEN = "open";
const TAB_LIVE = "live";

export default function LobbyList({ wallet, rulesAccepted, onShowRules, onJoinLobby, onCreateClick, onSpectate, activeTab: activeTabProp, onTabChange }) {
  const [internalTab, setInternalTab] = useState(TAB_OPEN);
  const activeTab = activeTabProp != null ? activeTabProp : internalTab;
  const setActiveTab = (t) => {
    if (onTabChange) onTabChange(t);
    else setInternalTab(t);
  };

  const [liveSearchWallet, setLiveSearchWallet] = useState("");
  const [lobbies, setLobbies] = useState([]);
  const [liveGames, setLiveGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [liveLoading, setLiveLoading] = useState(true);
  const [joiningLobbyId, setJoiningLobbyId] = useState(null);
  const [joinError, setJoinError] = useState(null);
  const [cancellingLobbyId, setCancellingLobbyId] = useState(null);
  const [cancelError, setCancelError] = useState(null);
  const [failedCancelLobby, setFailedCancelLobby] = useState(null); // lobby that failed on-chain cancel, so we can offer "Remove from list anyway"
  const [contractCancelReason, setContractCancelReason] = useState(null); // reason from reading contract state after cancel failed

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api("/api/lobbies");
        const data = await res.json();
        if (!cancelled) setLobbies(data.lobbies || []);
      } catch (_) {}
      if (!cancelled) setLoading(false);
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api("/api/lobbies?status=playing");
        const data = await res.json();
        if (!cancelled) setLiveGames(data.lobbies || []);
      } catch (_) {}
      if (!cancelled) setLiveLoading(false);
    };
    load();
    const t = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const join = async (lobby) => {
    if (!wallet) return;
    if (!rulesAccepted) {
      onShowRules?.();
      return;
    }
    const lobbyId = lobby?.lobbyId;
    if (!lobbyId || typeof lobbyId !== "string") {
      setJoinError("Invalid lobby: missing lobby id");
      return;
    }
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidV4.test(lobbyId)) {
      setJoinError("Invalid lobby: lobby id format is invalid");
      return;
    }
    setJoiningLobbyId(lobbyId);
    setJoinError(null);
    try {
      const betWei = lobby.betAmount ? String(lobby.betAmount) : "0";
      const needsOnChain = hasEscrow() && lobby.contractGameId != null && BigInt(betWei) > 0n;
      if (needsOnChain) {
        const ok = await joinLobbyOnChain(lobby.contractGameId, betWei);
        if (!ok) {
          setJoinError("Transaction failed or was rejected");
          setJoiningLobbyId(null);
          return;
        }
      }
      const { message, signature } = await signJoinLobby(lobbyId);
      const res = await api(`/api/lobbies/${lobbyId}/join`, {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });
      if (res.ok) {
        const data = await res.json();
        onJoinLobby(lobbyId, { ...lobby, fen: data.fen, status: "playing", player2Wallet: wallet });
      } else {
        const data = await res.json().catch(() => ({}));
        setJoinError(data?.error || "Failed to join lobby");
      }
    } catch (e) {
      setJoinError(e?.reason || e?.message || "Failed to join");
    } finally {
      setJoiningLobbyId(null);
    }
  };

  // When cancel failed and we have a lobby with contractGameId, read on-chain state to show why
  useEffect(() => {
    if (!failedCancelLobby || failedCancelLobby.contractGameId == null || !wallet) {
      setContractCancelReason(null);
      return;
    }
    setContractCancelReason("Reading contract state…");
    let cancelled = false;
    Promise.all([
      getGameStateOnChain(failedCancelLobby.contractGameId),
      getContractBalance(),
    ])
      .then(([state, balance]) => {
        if (cancelled) return;
        if (!state) {
          setContractCancelReason("Could not read contract state. Check you're on the correct Monad network and the contract address in .env is correct.");
          return;
        }
        const w = wallet.toLowerCase();
        const zero = "0x0000000000000000000000000000000000000000";
        if (!state.active) setContractCancelReason("Contract says: this lobby was already cancelled on-chain.");
        else if (state.player2 !== zero) setContractCancelReason("Contract says: someone already joined; you cannot cancel.");
        else if (state.player1 !== w) setContractCancelReason("Contract says: your wallet is not the creator on-chain.");
        else if (balance != null && state.betAmount && BigInt(balance) < BigInt(state.betAmount)) setContractCancelReason("Contract balance is too low to refund—contract may have been redeployed. Your bet may be in an old deployment. Use 'Remove from list anyway'.");
        else setContractCancelReason("Contract state: lobby is active and you're the creator. If the tx still reverts, the contract may not have enough balance to refund (e.g. after redeploy)—use 'Remove from list anyway'.");
      })
      .catch(() => setContractCancelReason("Could not read contract state. Check you're on the correct Monad network and the contract address in .env is correct."));
    return () => { cancelled = true; };
  }, [failedCancelLobby?.lobbyId, failedCancelLobby?.contractGameId, wallet]);

  const loadLobbies = async () => {
    try {
      const res = await api("/api/lobbies");
      const data = await res.json();
      setLobbies(data.lobbies || []);
    } catch (_) {}
  };

  const cancelLobby = async (lobby) => {
    if (!wallet || lobby.player1Wallet?.toLowerCase() !== wallet.toLowerCase()) return;
    const needsOnChain = hasEscrow() && lobby.contractGameId != null;
    setCancellingLobbyId(lobby.lobbyId);
    setCancelError(null);
    setFailedCancelLobby(null);
    setContractCancelReason(null);
    try {
      if (needsOnChain) {
        const ok = await cancelLobbyOnChain(lobby.contractGameId);
        if (!ok) {
          setCancelError("Transaction failed or was rejected");
          setFailedCancelLobby(needsOnChain ? lobby : null);
          setCancellingLobbyId(null);
          return;
        }
      }
      const { message, signature } = await signCancelLobby(lobby.lobbyId);
      const res = await api(`/api/lobbies/${lobby.lobbyId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });
      if (res.ok) {
        await loadLobbies();
        setFailedCancelLobby(null);
      } else {
        const data = await res.json().catch(() => ({}));
        setCancelError(data?.error || "Failed to cancel lobby");
      }
    } catch (e) {
      setCancelError(e?.message || e?.reason || "Failed to cancel");
      setFailedCancelLobby(needsOnChain ? lobby : null);
    } finally {
      setCancellingLobbyId(null);
    }
  };

  const removeLobbyFromListOnly = async () => {
    if (!failedCancelLobby || !wallet) return;
    setCancelError(null);
    try {
      const { message, signature } = await signCancelLobby(failedCancelLobby.lobbyId);
      const res = await api(`/api/lobbies/${failedCancelLobby.lobbyId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });
      if (res.ok) {
        setFailedCancelLobby(null);
        setContractCancelReason(null);
        await loadLobbies();
      } else {
        const data = await res.json().catch(() => ({}));
        setCancelError(data?.error || "Failed to remove from list");
      }
    } catch (e) {
      setCancelError(e?.message || "Failed to remove from list");
    }
  };

  return (
    <section className="lobby-list lobby-page">
      <div className="lobby-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === TAB_OPEN}
          className={`lobby-tab ${activeTab === TAB_OPEN ? "active" : ""}`}
          onClick={() => setActiveTab(TAB_OPEN)}
        >
          Open lobbies
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === TAB_LIVE}
          className={`lobby-tab ${activeTab === TAB_LIVE ? "active" : ""}`}
          onClick={() => setActiveTab(TAB_LIVE)}
        >
          Live games
        </button>
      </div>

      {activeTab === TAB_OPEN && (
        <>
          {!rulesAccepted && (
            <div className="lobby-rules-gate" role="alert">
              <p>You must accept the FIDE rules before creating or joining a game.</p>
              <button type="button" className="btn btn-rules-inline" onClick={onShowRules}>
                View &amp; accept rules
              </button>
            </div>
          )}
          <div className="lobby-actions-card">
            <div className="lobby-actions">
              <button
                type="button"
                className="btn btn-create"
                onClick={onCreateClick}
                disabled={!wallet || !rulesAccepted}
              >
                <span className="lobby-btn-icon">+</span>
                Create lobby
              </button>
            </div>
          </div>

          {(joinError || cancelError) && (
            <div className="lobby-error" role="alert">
              <p className="lobby-error-text">{joinError || cancelError}</p>
              {contractCancelReason && <p className="lobby-error-contract-reason">{contractCancelReason}</p>}
              {failedCancelLobby && (
                <div className="lobby-error-actions">
                  <p className="lobby-error-hint">
                    You can remove this lobby from the list so it no longer appears. Your bet may still be in the contract—try cancelling again, or call <code>cancelLobby({failedCancelLobby.contractGameId})</code> on the contract via a Monad block explorer.
                  </p>
                  <button
                    type="button"
                    className="btn btn-remove-from-list"
                    onClick={removeLobbyFromListOnly}
                  >
                    Remove from list anyway
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="lobby-content">
        {loading ? (
          <div className="lobby-empty">
            <span className="lobby-empty-icon">⋯</span>
            <p className="lobby-empty-title">Loading lobbies</p>
          </div>
        ) : lobbies.length === 0 ? (
          <div className="lobby-empty">
            <span className="lobby-empty-icon">♟</span>
            <p className="lobby-empty-title">No open lobbies</p>
            <p className="lobby-empty-desc">Create one to get started. Others can join and play.</p>
            <button
              type="button"
              className="btn btn-create btn-empty-cta"
              onClick={onCreateClick}
              disabled={!wallet}
            >
              Create lobby
            </button>
          </div>
        ) : (
          <ul className="lobby-cards lobby-cards-open">
            {lobbies.map((l) => {
              const isCreator = wallet && l.player1Wallet?.toLowerCase() === wallet.toLowerCase();
              const canCancel = isCreator;
              return (
                <li key={l.lobbyId} className="lobby-card">
                  <span className="lobby-card-icon">♟</span>
                  <div className="lobby-card-body">
                    <span className="lobby-card-bet">Bet: {betWeiToMon(l.betAmount)} MON</span>
                    <span className="lobby-card-creator">
                      {l.player1Wallet ? `${l.player1Wallet.slice(0, 6)}…${l.player1Wallet.slice(-4)}` : "—"}
                    </span>
                  </div>
                  <div className="lobby-card-actions">
                    {canCancel && (
                      <button
                        type="button"
                        className="btn btn-cancel-lobby"
                        onClick={() => cancelLobby(l)}
                        disabled={cancellingLobbyId === l.lobbyId}
                        title="Cancel lobby and get your bet back (no opponent yet)"
                      >
                        {cancellingLobbyId === l.lobbyId ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                    {isCreator ? (
                      <button
                        type="button"
                        className="btn btn-rejoin-lobby"
                        onClick={() => onJoinLobby(l.lobbyId, { ...l, status: "waiting", fen: l.fen })}
                        title="Return to your lobby and wait for an opponent"
                      >
                        Rejoin
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-join"
                        onClick={() => join(l)}
                        disabled={!wallet || !rulesAccepted || joiningLobbyId === l.lobbyId}
                      >
                        {joiningLobbyId === l.lobbyId ? "Joining…" : "Join"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
          </div>
        </>
      )}

      {activeTab === TAB_LIVE && (
        <div className="lobby-live-section">
          <p className="lobby-live-subtitle">Spectate games in progress</p>
          <div className="lobby-live-search">
            <label htmlFor="live-search-wallet" className="lobby-live-search-label">Search by wallet</label>
            <input
              id="live-search-wallet"
              type="text"
              className="lobby-live-search-input"
              placeholder="e.g. 0x1234…abcd"
              value={liveSearchWallet}
              onChange={(e) => setLiveSearchWallet(e.target.value)}
              aria-label="Filter live games by wallet address"
            />
          </div>
          {liveLoading ? (
            <div className="lobby-empty">
              <span className="lobby-empty-icon">⋯</span>
              <p className="lobby-empty-title">Loading live games</p>
            </div>
          ) : (() => {
            const search = liveSearchWallet.trim().toLowerCase();
            const filtered = search
              ? liveGames.filter(
                  (l) =>
                    (l.player1Wallet || "").toLowerCase().includes(search) ||
                    (l.player2Wallet || "").toLowerCase().includes(search)
                )
              : liveGames;
            return filtered.length === 0 ? (
              <div className="lobby-empty">
                <span className="lobby-empty-icon">♟</span>
                <p className="lobby-empty-title">{liveGames.length === 0 ? "No live games" : "No games match wallet"}</p>
                <p className="lobby-empty-desc">
                  {liveGames.length === 0
                    ? "Games in progress will appear here. Create or join a game to start playing."
                    : "Try a different wallet search."}
                </p>
              </div>
            ) : (
              <ul className="lobby-cards lobby-cards-live">
                {filtered.map((l) => {
                  const turnCount = getTurnCount(l.fen);
                  return (
                    <li key={l.lobbyId} className="lobby-card lobby-card-live">
                      <span className="lobby-card-icon">♟</span>
                      <div className="lobby-card-body">
                        <span className="lobby-card-bet">Bet: {betWeiToMon(l.betAmount)} MON</span>
                        <span className="lobby-card-creator">
                          {l.player1Wallet ? `${l.player1Wallet.slice(0, 6)}…${l.player1Wallet.slice(-4)}` : "—"} vs {l.player2Wallet ? `${l.player2Wallet.slice(0, 6)}…${l.player2Wallet.slice(-4)}` : "—"}
                        </span>
                        <span className="lobby-card-turn">Turn {turnCount}</span>
                      </div>
                      <div className="lobby-card-actions">
                        <button
                          type="button"
                          className="btn btn-spectate"
                          onClick={() => onSpectate?.(l.lobbyId)}
                          title="Watch this game live"
                        >
                          Spectate
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            );
          })()}
        </div>
      )}
    </section>
  );
}

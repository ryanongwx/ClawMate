import React, { useState, useEffect } from "react";
import { formatEther } from "ethers";
import { io } from "socket.io-client";
import Landing from "./components/Landing";
import LobbyList from "./components/LobbyList";
import CreateLobby from "./components/CreateLobby";
import GameView from "./components/GameView";
import SpectateView from "./components/SpectateView";
import RulesModal from "./components/RulesModal";
import WalletBar from "./components/WalletBar";
import ErrorBoundary from "./components/ErrorBoundary";
import { getApiUrl, api } from "./lib/api";
import { signRegisterWallet } from "./lib/auth";

const socket = io(getApiUrl(), { path: "/socket.io", transports: ["websocket", "polling"] });

const CURRENT_GAME_KEY = "clawmate_current_game";
const RULES_ACCEPTED_KEY = "clawmate_rules_accepted";

function loadRulesAccepted() {
  try {
    return localStorage.getItem(RULES_ACCEPTED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveRulesAccepted() {
  try {
    localStorage.setItem(RULES_ACCEPTED_KEY, "1");
  } catch (_) {}
}

export default function App() {
  const [view, setView] = useState("landing"); // landing | lobbies | create | game | spectate
  const [lobbyId, setLobbyId] = useState(null);
  const [lobby, setLobby] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(loadRulesAccepted);
  const [isTestGame, setIsTestGame] = useState(false);
  const [rejoinBanner, setRejoinBanner] = useState(null); // { lobbyId, lobby }
  const [toast, setToast] = useState(null); // { lobbyId, betAmount, player2Wallet } when someone joins your lobby

  const openGame = (id, lobbyData, opts) => {
    setLobbyId(id);
    setLobby(lobbyData || null);
    setIsTestGame(opts?.testMode ?? false);
    setView("game");
    if (lobbyData?.status === "playing" && !opts?.testMode) {
      try {
        localStorage.setItem(CURRENT_GAME_KEY, JSON.stringify({ lobbyId: id, ...lobbyData }));
      } catch (_) {}
    }
  };

  const backToLobbies = () => {
    setLobbyId(null);
    setLobby(null);
    setIsTestGame(false);
    setView("lobbies");
  };

  const openSpectate = (id) => {
    setLobbyId(id);
    setLobby(null);
    setView("spectate");
  };

  const clearCurrentGame = () => {
    try {
      localStorage.removeItem(CURRENT_GAME_KEY);
    } catch (_) {}
    setRejoinBanner(null);
  };

  const onGameEnd = () => {
    clearCurrentGame();
    backToLobbies();
  };

  useEffect(() => {
    if (!wallet) return;
    signRegisterWallet()
      .then(({ message, signature }) => socket.emit("register_wallet", { message, signature }))
      .catch(() => {});
  }, [wallet]);

  useEffect(() => {
    const onLobbyJoinedYours = (data) => {
      setToast({ lobbyId: data.lobbyId, betAmount: data.betAmount, player2Wallet: data.player2Wallet });
    };
    socket.on("lobby_joined_yours", onLobbyJoinedYours);
    return () => socket.off("lobby_joined_yours", onLobbyJoinedYours);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!wallet || view === "game") return;
    const raw = localStorage.getItem(CURRENT_GAME_KEY);
    if (!raw) return;
    let stored;
    try {
      stored = JSON.parse(raw);
    } catch {
      return;
    }
    if (!stored?.lobbyId) return;
    const pw = wallet.toLowerCase();
    const fetchLobby = async () => {
      try {
        const res = await api(`/api/lobbies/${stored.lobbyId}`);
        const data = await res.json();
        if (data.status === "playing" && (data.player1Wallet?.toLowerCase() === pw || data.player2Wallet?.toLowerCase() === pw)) {
          setRejoinBanner({ lobbyId: data.lobbyId, lobby: data });
        } else {
          clearCurrentGame();
        }
      } catch {
        setRejoinBanner(null);
      }
    };
    fetchLobby();
  }, [wallet, view]);

  const dismissRejoin = () => {
    clearCurrentGame();
  };

  const rejoinGame = () => {
    if (rejoinBanner) {
      openGame(rejoinBanner.lobbyId, rejoinBanner.lobby, {});
      setRejoinBanner(null);
    }
  };

  const openLobbyFromToast = () => {
    if (!toast) return;
    api(`/api/lobbies/${toast.lobbyId}`)
      .then((r) => r.json())
      .then((data) => {
        openGame(toast.lobbyId, data, {});
        setToast(null);
      })
      .catch(() => setToast(null));
  };

  return (
    <div className="app clawgig-style">
      <header className="header">
        <a href="#" className="header-logo" onClick={(e) => { e.preventDefault(); setView("landing"); }}>
          ClawMate
        </a>
        <nav className="header-nav">
          {view === "landing" && (
            <button type="button" className="btn btn-nav" onClick={() => setView("lobbies")}>
              Play
            </button>
          )}
          <WalletBar wallet={wallet} setWallet={setWallet} />
        </nav>
      </header>

      {showRulesModal && (
        <RulesModal
          onClose={() => setShowRulesModal(false)}
          onAccept={() => {
            saveRulesAccepted();
            setRulesAccepted(true);
          }}
        />
      )}

      {toast && (
        <div className="toast toast-bottom-right" role="status">
          <p className="toast-title">Someone joined your lobby</p>
          <p className="toast-desc">Bet: {(() => { try { return formatEther(toast.betAmount || "0"); } catch { return "0"; } })()} MON</p>
          <div className="toast-actions">
            <button type="button" className="btn btn-toast-rejoin" onClick={openLobbyFromToast}>
              Rejoin
            </button>
            <button type="button" className="btn btn-toast-dismiss" onClick={() => setToast(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {rejoinBanner && view !== "game" && (
        <div className="rejoin-banner" role="region" aria-label="Active match">
          <span className="rejoin-banner-text">You have an active match. Rejoin to continue.</span>
          <div className="rejoin-banner-actions">
            <button type="button" className="btn btn-rejoin" onClick={rejoinGame}>
              Rejoin
            </button>
            <button type="button" className="btn btn-dismiss-rejoin" onClick={dismissRejoin}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <main className="main">
        <ErrorBoundary onReset={backToLobbies}>
          {view === "landing" && (
            <Landing
              onPlayNow={() => setView("lobbies")}
              onShowRules={() => setShowRulesModal(true)}
            />
          )}
          {view === "lobbies" && (
            <>
              <LobbyList
                wallet={wallet}
                rulesAccepted={rulesAccepted}
                onShowRules={() => setShowRulesModal(true)}
                onJoinLobby={openGame}
                onCreateClick={() => {
                  if (!rulesAccepted) {
                    setShowRulesModal(true);
                    return;
                  }
                  setView("create");
                }}
                onSpectate={openSpectate}
              />
            </>
          )}
          {view === "create" && (
            <CreateLobby
              wallet={wallet}
              rulesAccepted={rulesAccepted}
              onShowRules={() => setShowRulesModal(true)}
              onCreated={openGame}
              onBack={() => setView("lobbies")}
            />
          )}
          {view === "game" && lobbyId && (
            <GameView
              lobbyId={lobbyId}
              lobby={lobby}
              wallet={wallet}
              socket={socket}
              onBack={backToLobbies}
              onGameEnd={onGameEnd}
              isTestGame={isTestGame}
            />
          )}
          {view === "spectate" && lobbyId && (
            <SpectateView lobbyId={lobbyId} socket={socket} onBack={backToLobbies} />
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}

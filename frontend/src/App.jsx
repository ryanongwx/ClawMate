import React, { useState, useEffect } from "react";
import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
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
  const navigate = useNavigate();
  const location = useLocation();
  const [wallet, setWallet] = useState(null);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [rulesAccepted, setRulesAccepted] = useState(loadRulesAccepted);
  const [rejoinBanner, setRejoinBanner] = useState(null); // { lobbyId, lobby }
  const [toast, setToast] = useState(null); // { lobbyId, betAmount, player2Wallet } when someone joins your lobby

  const isInGame = location.pathname.startsWith("/game/");

  const openGame = (id, lobbyData, opts) => {
    if (lobbyData?.status === "playing" && !opts?.testMode) {
      try {
        localStorage.setItem(CURRENT_GAME_KEY, JSON.stringify({ lobbyId: id, ...lobbyData }));
      } catch (_) {}
    }
    navigate(`/game/${id}`, { state: { lobby: lobbyData || null, isTestGame: opts?.testMode ?? false } });
  };

  /** Navigate to lobby list without clearing current game, so rejoin banner can show. */
  const backToLobbies = () => {
    navigate("/lobbies");
  };

  const openSpectate = (id) => {
    navigate(`/watch/${id}`);
  };

  const clearCurrentGame = () => {
    try {
      localStorage.removeItem(CURRENT_GAME_KEY);
    } catch (_) {}
    setRejoinBanner(null);
  };

  const onGameEnd = () => {
    clearCurrentGame();
    navigate("/lobbies");
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
    if (!wallet || isInGame) return;
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
  }, [wallet, isInGame]);

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

  const handleLobbyTabChange = (tab) => {
    if (tab === "live") navigate("/livegames");
    else if (tab === "leaderboard") navigate("/leaderboard");
    else navigate("/lobbies");
  };

  return (
    <div className="app clawgig-style">
      <header className="header">
        <a href="/" className="header-logo" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          ClawMate
        </a>
        <nav className="header-nav">
          {location.pathname === "/" && (
            <button type="button" className="btn btn-nav" onClick={() => navigate("/lobbies")}>
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

      {rejoinBanner && !isInGame && (
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
          <Routes>
            <Route
              path="/"
              element={
                <Landing
                  onPlayNow={() => navigate("/lobbies")}
                  onShowRules={() => setShowRulesModal(true)}
                />
              }
            />
            <Route
              path="/lobbies"
              element={
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
                    navigate("/create");
                  }}
                  onSpectate={openSpectate}
                  activeTab="open"
                  onTabChange={handleLobbyTabChange}
                />
              }
            />
            <Route
              path="/livegames"
              element={
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
                    navigate("/create");
                  }}
                  onSpectate={openSpectate}
                  activeTab="live"
                  onTabChange={handleLobbyTabChange}
                />
              }
            />
            <Route
              path="/leaderboard"
              element={
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
                    navigate("/create");
                  }}
                  onSpectate={openSpectate}
                  activeTab="leaderboard"
                  onTabChange={handleLobbyTabChange}
                />
              }
            />
            <Route path="/create" element={
              <CreateLobby
                wallet={wallet}
                rulesAccepted={rulesAccepted}
                onShowRules={() => setShowRulesModal(true)}
                onCreated={openGame}
                onBack={() => navigate("/lobbies")}
              />
            } />
            <Route path="/watch/:lobbyId" element={<SpectateRoute socket={socket} onBack={() => navigate("/livegames")} />} />
            <Route path="/game/:lobbyId" element={<GameRoute wallet={wallet} socket={socket} onBack={backToLobbies} onGameEnd={onGameEnd} />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function SpectateRoute({ socket, onBack }) {
  const { lobbyId } = useParams();
  if (!lobbyId) return null;
  return <SpectateView lobbyId={lobbyId} socket={socket} onBack={onBack} />;
}

function GameRoute({ wallet, socket, onBack, onGameEnd }) {
  const { lobbyId } = useParams();
  const location = useLocation();
  const state = location.state || {};
  const initialLobby = state.lobby ?? null;
  const isTestGame = state.isTestGame ?? false;
  if (!lobbyId) return null;
  return (
    <GameView
      lobbyId={lobbyId}
      lobby={initialLobby}
      wallet={wallet}
      socket={socket}
      onBack={onBack}
      onGameEnd={onGameEnd}
      isTestGame={isTestGame}
    />
  );
}

import React, { useState, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { signConcedeLobby, signTimeoutLobby, signRegisterWallet } from "../lib/auth";
import ThreeChessBoard from "./ThreeChessBoard";
import GameOverModal from "./GameOverModal";
import CapturedPieces from "./CapturedPieces";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const INITIAL_TIME_SEC = 10 * 60; // 10 minutes

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function GameView({ lobbyId, lobby: initialLobby, wallet, socket, onBack, onGameEnd, isTestGame }) {
  const [lobby, setLobby] = useState(initialLobby || null);
  const [fen, setFen] = useState(() => {
    const f = initialLobby?.fen;
    return typeof f === "string" && f.length > 0 ? f : START_FEN;
  });
  const [status, setStatus] = useState(initialLobby?.status || "waiting");
  const [winner, setWinner] = useState(initialLobby?.winner ?? null);
  const [whiteTime, setWhiteTime] = useState(INITIAL_TIME_SEC);
  const [blackTime, setBlackTime] = useState(INITIAL_TIME_SEC);
  const [gameOverReason, setGameOverReason] = useState(null);
  const [showGameOverModal, setShowGameOverModal] = useState(false);
  const [showConcedeConfirm, setShowConcedeConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [concedeLoading, setConcedeLoading] = useState(false);
  const timersInitialized = useRef(false);
  const lobbyRef = useRef(initialLobby);
  useEffect(() => {
    lobbyRef.current = lobby ?? initialLobby;
  }, [lobby, initialLobby]);

  useEffect(() => {
    socket.emit("join_lobby", lobbyId);
    const onJoinError = () => {
      if (wallet) {
        signRegisterWallet()
          .then(({ message, signature }) => {
            socket.emit("register_wallet", { message, signature });
            socket.emit("join_lobby", lobbyId);
          })
          .catch(() => {});
      }
    };
    socket.on("join_lobby_error", onJoinError);
    return () => {
      socket.off("join_lobby_error", onJoinError);
      socket.emit("leave_lobby", lobbyId);
      timersInitialized.current = false;
    };
  }, [lobbyId, socket, wallet]);

  useEffect(() => {
    if (status === "playing" && !timersInitialized.current) {
      setWhiteTime(INITIAL_TIME_SEC);
      setBlackTime(INITIAL_TIME_SEC);
      timersInitialized.current = true;
    }
    if (status !== "playing") timersInitialized.current = false;
  }, [status]);

  useEffect(() => {
    const onMove = (payload) => {
      setFen(payload.fen);
      if (payload.status) setStatus(payload.status);
      if (payload.winner != null) {
        setWinner(payload.winner);
        if (payload.concede) {
          const l = lobbyRef.current;
          const isWhite = l?.player1Wallet === wallet;
          const weWon = (payload.winner === "white" && isWhite) || (payload.winner === "black" && !isWhite);
          setGameOverReason(weWon ? "opponent_concede" : "concede");
        } else {
          setGameOverReason(payload.winner === "draw" ? "draw" : "checkmate");
        }
        setShowGameOverModal(true);
      }
    };
    const onLobbyJoined = (payload) => {
      setFen(payload.fen);
      setStatus("playing");
    };
    socket.on("move", onMove);
    socket.on("lobby_joined", onLobbyJoined);
    return () => {
      socket.off("move", onMove);
      socket.off("lobby_joined", onLobbyJoined);
    };
  }, [socket]);

  useEffect(() => {
    if (lobbyId && !lobby) {
      api(`/api/lobbies/${lobbyId}`)
        .then((r) => r.json())
        .then((data) => {
          setLobby(data);
          const f = data.fen;
          if (typeof f === "string" && f.length > 0) setFen(f);
          if (data.status) setStatus(data.status);
          if (data.winner != null) {
            setWinner(data.winner);
            setGameOverReason(data.winner === "draw" ? "draw" : "checkmate");
            setShowGameOverModal(true);
          }
        })
        .catch(() => {});
    }
  }, [lobbyId, lobby]);

  // Timer: every second, decrement current side's time. On 0, that side loses.
  useEffect(() => {
    if (status !== "playing" || winner != null) return;
    const turn = typeof fen === "string" ? (fen.split(" ")[1] || "w") : "w";
    const interval = setInterval(() => {
      if (turn === "w") {
        setWhiteTime((t) => {
          if (t <= 1) {
            setWinner("black");
            setStatus("finished");
            setGameOverReason("timeout");
            setShowGameOverModal(true);
            signTimeoutLobby(lobbyId)
              .then(({ message, signature }) =>
                api(`/api/lobbies/${lobbyId}/timeout`, {
                  method: "POST",
                  body: JSON.stringify({ message, signature }),
                })
              )
              .catch(() => {});
            return 0;
          }
          return t - 1;
        });
      } else {
        setBlackTime((t) => {
          if (t <= 1) {
            setWinner("white");
            setStatus("finished");
            setGameOverReason("timeout");
            setShowGameOverModal(true);
            signTimeoutLobby(lobbyId)
              .then(({ message, signature }) =>
                api(`/api/lobbies/${lobbyId}/timeout`, {
                  method: "POST",
                  body: JSON.stringify({ message, signature }),
                })
              )
              .catch(() => {});
            return 0;
          }
          return t - 1;
        });
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [status, winner, fen, lobbyId]);

  const handleMove = (from, to, promotion) => {
    socket.emit("move", { lobbyId, from, to, promotion: promotion || "q" });
  };

  const handleBackClick = () => {
    if (!isTestGame && status === "playing" && (lobby?.player1Wallet === wallet || lobby?.player2Wallet === wallet)) {
      setShowLeaveConfirm(true);
    } else {
      onBack();
    }
  };

  const handleConcedeConfirm = async () => {
    if (!wallet || isTestGame) return;
    setConcedeLoading(true);
    try {
      const { message, signature } = await signConcedeLobby(lobbyId);
      const res = await api(`/api/lobbies/${lobbyId}/concede`, {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });
      if (res.ok) {
        const data = await res.json();
        setWinner(data.winner);
        setStatus("finished");
        setGameOverReason("concede");
        setShowGameOverModal(true);
        setShowConcedeConfirm(false);
      }
    } catch (_) {}
    setConcedeLoading(false);
  };

  const isWhite = lobby?.player1Wallet === wallet;
  const isBlack = lobby?.player2Wallet === wallet;
  const turn = typeof fen === "string" ? (fen.split(" ")[1] || "w") : "w";
  const myTurn = isTestGame ? true : (status === "playing" && ((turn === "b" && isBlack) || (turn === "w" && isWhite)));
  const whiteToMove = turn === "w";

  return (
    <section className="game-view">
      <button type="button" className="btn btn-ghost" onClick={handleBackClick}>← Back</button>

      <div className="turn-and-timers">
        <div className={`turn-tile turn-white ${whiteToMove && status === "playing" ? "active" : ""}`}>
          <span className="turn-label">Blue</span>
          <span className="turn-time">{formatTime(whiteTime)}</span>
          {whiteToMove && status === "playing" && <span className="turn-badge">To move</span>}
        </div>
        <div className={`turn-tile turn-black ${!whiteToMove && status === "playing" ? "active" : ""}`}>
          <span className="turn-label">Pink</span>
          <span className="turn-time">{formatTime(blackTime)}</span>
          {!whiteToMove && status === "playing" && <span className="turn-badge">To move</span>}
        </div>
      </div>

      <div className="game-meta">
        <span>Lobby: {lobbyId?.slice(0, 8)}…</span>
        {status === "waiting" && <span className="status waiting">Waiting for opponent</span>}
        {status === "playing" && (
          <span className="status playing">
            {isTestGame ? "Test mode · Move any piece" : myTurn ? "Your turn" : "Opponent's turn"}
          </span>
        )}
        {status === "finished" && !showGameOverModal && (
          <span className="status finished">
            Game over · {winner === "draw" ? "Draw" : winner === "white" ? "Blue wins" : "Pink wins"}
          </span>
        )}
        {status === "playing" && !isTestGame && wallet && (
          <button
            type="button"
            className="btn btn-concede"
            onClick={() => setShowConcedeConfirm(true)}
            title="Concede and lose the game"
          >
            Concede
          </button>
        )}
      </div>

      <div className="board-with-captured">
        <CapturedPieces side="blue" fen={fen} />
        <ThreeChessBoard
          key={isTestGame ? "test" : "game"}
          gameId={lobbyId}
          fen={fen}
          onMove={handleMove}
          orientation={isBlack ? "black" : "white"}
          disabled={!isTestGame && (!myTurn || status !== "playing")}
          isTestGame={!!isTestGame}
        />
        <CapturedPieces side="pink" fen={fen} />
      </div>

      {showGameOverModal && status === "finished" && (
        <GameOverModal
          winner={winner}
          reason={gameOverReason}
          onClose={() => {
            setShowGameOverModal(false);
            onGameEnd?.();
            onBack();
          }}
        />
      )}

      {showConcedeConfirm && (
        <div className="modal-overlay" onClick={() => !concedeLoading && setShowConcedeConfirm(false)}>
          <div className="modal concede-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Concede defeat?</h3>
            <p>Are you sure you want to concede? This will count as a loss.</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => !concedeLoading && setShowConcedeConfirm(false)}
                disabled={concedeLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-concede-confirm"
                onClick={handleConcedeConfirm}
                disabled={concedeLoading}
              >
                {concedeLoading ? "Conceding…" : "Concede defeat"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLeaveConfirm && (
        <div className="modal-overlay" onClick={() => setShowLeaveConfirm(false)}>
          <div className="modal leave-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Leave match?</h3>
            <p>You&apos;re in a match. Leave anyway? You can rejoin later from the main page.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setShowLeaveConfirm(false)}>
                Stay
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowLeaveConfirm(false);
                  onBack();
                }}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

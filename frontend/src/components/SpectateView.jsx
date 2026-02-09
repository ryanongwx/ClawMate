import React, { useState, useEffect } from "react";
import { api } from "../lib/api";
import ThreeChessBoard from "./ThreeChessBoard";
import GameOverModal from "./GameOverModal";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function shortAddr(addr) {
  if (!addr || typeof addr !== "string") return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function SpectateView({ lobbyId, socket, onBack }) {
  const [lobby, setLobby] = useState(null);
  const [fen, setFen] = useState(START_FEN);
  const [status, setStatus] = useState("playing");
  const [winner, setWinner] = useState(null);
  const [showGameOverModal, setShowGameOverModal] = useState(false);

  useEffect(() => {
    if (!lobbyId || !socket) return;
    socket.emit("spectate_lobby", lobbyId);
    const onGameState = (payload) => {
      if (payload.fen) setFen(payload.fen);
      if (payload.status) setStatus(payload.status);
      if (payload.winner != null) {
        setWinner(payload.winner);
        setShowGameOverModal(true);
      }
    };
    const onMove = (payload) => {
      if (payload.fen) setFen(payload.fen);
      if (payload.status) setStatus(payload.status);
      if (payload.winner != null) {
        setWinner(payload.winner);
        setShowGameOverModal(true);
      }
    };
    const onError = () => {}; // spectate_error — could show toast
    socket.on("game_state", onGameState);
    socket.on("move", onMove);
    socket.on("spectate_error", onError);
    return () => {
      socket.off("game_state", onGameState);
      socket.off("move", onMove);
      socket.off("spectate_error", onError);
      socket.emit("leave_lobby", lobbyId);
    };
  }, [lobbyId, socket]);

  useEffect(() => {
    if (!lobbyId || lobby) return;
    api(`/api/lobbies/${lobbyId}`)
      .then((r) => r.json())
      .then((data) => {
        setLobby(data);
        if (data.fen) setFen(data.fen);
        if (data.status) setStatus(data.status);
        if (data.winner != null) {
          setWinner(data.winner);
          setShowGameOverModal(true);
        }
      })
      .catch(() => {});
  }, [lobbyId, lobby]);

  const turn = typeof fen === "string" ? (fen.split(" ")[1] || "w") : "w";
  const whiteToMove = turn === "w";

  return (
    <section className="game-view spectate-view">
      <button type="button" className="btn btn-ghost" onClick={onBack}>
        ← Back
      </button>

      <div className="spectate-badge">Spectating</div>

      <div className="turn-and-timers">
        <div className={`turn-tile turn-white ${whiteToMove && status === "playing" ? "active" : ""}`}>
          <span className="turn-label">White</span>
          <span className="turn-addr">{shortAddr(lobby?.player1Wallet)}</span>
          {whiteToMove && status === "playing" && <span className="turn-badge">To move</span>}
        </div>
        <div className={`turn-tile turn-black ${!whiteToMove && status === "playing" ? "active" : ""}`}>
          <span className="turn-label">Black</span>
          <span className="turn-addr">{shortAddr(lobby?.player2Wallet)}</span>
          {!whiteToMove && status === "playing" && <span className="turn-badge">To move</span>}
        </div>
      </div>

      <div className="game-meta">
        <span>Lobby: {lobbyId?.slice(0, 8)}…</span>
        {status === "playing" && (
          <span className="status playing">{whiteToMove ? "White to move" : "Black to move"}</span>
        )}
        {status === "finished" && !showGameOverModal && (
          <span className="status finished">
            Game over · {winner === "draw" ? "Draw" : winner === "white" ? "White wins" : "Black wins"}
          </span>
        )}
      </div>

      <ThreeChessBoard
        gameId={`spectate-${lobbyId}`}
        fen={fen}
        onMove={() => {}}
        orientation="white"
        disabled
      />

      {showGameOverModal && status === "finished" && (
        <GameOverModal
          winner={winner}
          reason={winner === "draw" ? "draw" : "checkmate"}
          onClose={() => {
            setShowGameOverModal(false);
            onBack();
          }}
        />
      )}
    </section>
  );
}

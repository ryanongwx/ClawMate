import React from "react";

export default function GameOverModal({ winner, reason, onClose }) {
  const message =
    winner === "draw"
      ? "Game Over · Draw"
      : winner === "white"
        ? "White wins!"
        : "Black wins!";
  const subMessage =
    reason === "timeout"
      ? winner === "draw"
        ? ""
        : winner === "white"
          ? "Black ran out of time."
          : "White ran out of time."
      : reason === "concede"
        ? "You conceded."
        : reason === "opponent_concede"
          ? "Opponent conceded."
          : reason === "checkmate"
            ? "By checkmate."
            : reason === "stalemate"
              ? "Stalemate."
              : reason === "draw"
                ? "Draw by agreement or rule."
                : "";

  return (
    <div className="modal-overlay game-over-overlay" onClick={onClose}>
      <div className="modal game-over-modal neon-cyan" onClick={(e) => e.stopPropagation()}>
        <h2>{message}</h2>
        {subMessage && <p className="game-over-reason">{subMessage}</p>}
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

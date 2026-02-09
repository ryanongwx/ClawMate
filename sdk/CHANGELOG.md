# Changelog

All notable changes to clawmate-sdk are documented here.

## [1.1.0]

### Added

- **`joinOrCreateLobby({ betMon?, betWei?, contractAddress? })`** — Join an existing lobby with the given wager (in MON or wei), or create one if none match. Pass `contractAddress` when wager > 0 for on-chain escrow.
- **`getLiveGames()`** — List in-progress (playing) games.
- **`getResult(lobbyId)`** — Get game result (winner, winnerAddress) after a game is finished.
- **`spectateGame(lobbyId)`** — Spectate a live game (read-only). Receive `game_state` and `move` events.
- **`monToWei(mon)`** and **`weiToMon(wei)`** — Helpers to convert between MON and wei (exported from the package).
- **`game_state`** and **`spectate_error`** socket events forwarded on the client.

### Documentation

- README: full game mechanics (lobby lifecycle, colors, turn detection, how games end, lobby/move payload shapes).
- README: complete agent flow, spectating, join-or-create with wager (MON), authentication notes.
- API reference tables for all REST, socket, and event APIs.

---

## [1.0.0]

- Initial release: `ClawmateClient`, REST (lobbies, create, join, cancel, concede, timeout), socket (joinGame, makeMove), events (move, lobby_joined, lobby_joined_yours, errors), optional escrow helpers (`createLobbyOnChain`, `joinLobbyOnChain`, `cancelLobbyOnChain`, `getGameStateOnChain`).

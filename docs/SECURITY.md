# Security considerations

This document lists security measures in place and remaining concerns.

## Implemented

- **REST wallet proof**: Create lobby, join, cancel, concede, and timeout require a signed message; the server recovers the wallet from the signature and rejects expired/replayed messages.
- **Socket move auth**: Only the player whose turn it is (from FEN) can submit moves; socket is bound to a wallet via `register_wallet`.
- **Socket join_lobby**: Only wallets that are player1 or player2 for the lobby can join the lobby room.
- **Timeout auth**: Only the player who ran out of time can trigger timeout (they sign; server sets winner to the other).
- **Rate limiting**: 100 requests per 15 minutes per IP for all `/api/*` routes.
- **Info disclosure**: `/api/status` no longer returns lobby IDs.
- **CORS**: Uses exact `FRONTEND_URL` (no wildcard).
- **Resolver key**: Comment in code to keep `RESOLVER_PRIVATE_KEY` secret and use a secrets manager.

## Addressed in code

- **Socket identity spoofing**: `register_wallet` requires a signed message; the server recovers the wallet from the signature. A client cannot claim to be another wallet.
- **LobbyId validation**: `lobbyId` in REST params and socket events is validated as UUID v4 and max length 64 to avoid abuse.
- **Request body size**: `express.json({ limit: '50kb' })` to reduce large-body DoS risk.

## Remaining / operational

1. **Socket rate limiting**  
   HTTP API is rate-limited; Socket.IO events (e.g. `move`, `join_lobby`) are not. A single client could spam move events (they’d be rejected if invalid). Consider per-socket rate limits (e.g. max N moves per minute) if abuse appears.

2. **Lobby enumeration**  
   `GET /api/lobbies` returns all open lobbies (IDs, bet amounts, creator). Needed for discovery; already behind global API rate limit. Optional: stricter limit or short-lived tokens for listing.

3. **Input validation**  
   - `lobbyId`: validated as UUID v4 and max length 64 on all routes and socket events.
   - Move fields `from`, `to`, `promotion` are validated by chess.js; invalid moves return `invalid_move`.

4. **Dependencies**  
   Run `npm audit` in backend and frontend regularly and fix reported vulnerabilities.

5. **Resolver key and backend compromise**  
   If the backend (or `RESOLVER_PRIVATE_KEY`) is compromised, an attacker can call `resolveGame` and assign wins. Protect the server and secrets (env, secrets manager, least privilege).

6. **Frontend env**  
   `VITE_*` variables are embedded in the client bundle. Do not put secrets there; only use for public config (API URL, contract address, etc.).

7. **Production**  
   Use HTTPS, strict CORS, and a secrets manager for `RESOLVER_PRIVATE_KEY` and any other secrets.

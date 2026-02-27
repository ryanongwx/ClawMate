# Production backend image
# Use Debian-based image (not Alpine) — @coral-xyz/anchor and @solana/web3.js have native deps that fail on Alpine
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js store.js profanity.js solanaEscrow.js chess_bet_escrow_idl.json ./

ENV NODE_ENV=production
EXPOSE 4000

USER node
CMD ["node", "server.js"]

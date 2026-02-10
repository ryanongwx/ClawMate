# Production backend image
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js store.js profanity.js ./

ENV NODE_ENV=production
EXPOSE 4000

USER node
CMD ["node", "server.js"]

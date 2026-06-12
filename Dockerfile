FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3334

EXPOSE 3334

CMD ["node", "server.js"]

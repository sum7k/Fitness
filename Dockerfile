FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV DB_PATH=/app/data/fitness.db

RUN mkdir -p /app/data

# Long-polling Telegram bot — no HTTP port required.
CMD ["npx", "tsx", "src/main.ts"]

# Multiplayer Drawing & Guessing Game

A Pictionary-style browser game: one player draws a secret word and everyone else races to guess it in chat. The server is the only authority on words, time and points.

- `apps/server`: Node.js, Express, Socket.IO, Prisma, PostgreSQL
- `apps/web`: React, Vite
- pnpm workspace; PostgreSQL runs in Docker

## Prerequisites

- Node.js 20.19+ (24 LTS recommended) and pnpm 10 (`corepack enable`)
- Docker Desktop, running

## Run it in development (one command)

```bash
pnpm install
pnpm dev
```

`pnpm dev` does all of this:

1. Starts PostgreSQL in Docker on `127.0.0.1:5434` and waits until it is healthy.
2. Creates `apps/server/.env` from `.env.example` if it is missing, generates the Prisma client and applies migrations.
3. Runs the API on `:3000` with hot reload, and the web app on **http://localhost:5173** with hot reload.

Open http://localhost:5173. Vite proxies `/api` and `/socket.io` to the server, so the browser sees a single origin. Use separate browsers or private windows for separate players. A game needs 3 connected players (`MIN_PLAYERS_TO_START` in `apps/server/.env`).

Other scripts, all run from the repository root:

| Command | What it does |
| --- | --- |
| `pnpm dev:server` / `pnpm dev:web` | Run one side only |
| `pnpm db:stop` | Stop the development database (data is kept) |
| `pnpm test` | Server rule tests (fast, no Docker) |
| `pnpm test:integration` | API, Socket.IO and restart tests against a throwaway PostgreSQL (needs Docker) |
| `pnpm typecheck` / `pnpm build` | Type-check / build both apps |
| `pnpm load -- --rooms 25 --players 8` | Load harness (see `apps/server/scripts/load.ts`) |

## Run it with Docker only

```bash
docker compose up --build
```

This runs PostgreSQL, a one-shot migration job and the API server. The web container is added with the frontend; once it is, the game will be at http://localhost:8080. `docker compose down` stops everything and keeps the data. `docker compose down -v` also **deletes** the database volume.

# Doodle Dash: multiplayer drawing & guessing

A Pictionary-style browser game in the spirit of skribbl.io. One player picks a secret word and draws it; everyone else races to guess it in chat. Faster correct guesses earn more points. The server is the only authority on words, time and points.

- `apps/server`: Node.js, Express, Socket.IO, Prisma, PostgreSQL
- `apps/web`: React, Vite, Tailwind CSS (canvas drawing with a deterministic, skribbl-style rasterizer)
- pnpm workspace; PostgreSQL runs in Docker

## Run the game (one command)

Prerequisite: Docker Desktop / Docker Engine with Compose.

```bash
docker compose up --build
```

Open **http://localhost:8080**. This builds and starts:

1. PostgreSQL (data kept in the `postgres_data` volume)
2. a one-shot migration job (`prisma migrate deploy`)
3. the API / Socket.IO server
4. Nginx, which serves the web app and proxies `/api` and `/socket.io` to the server

To play, open the link in three separate browsers (or private windows), create a room in one, and share the invite link. A game needs 3 connected players.

- `docker compose down` stops everything and **keeps** the data.
- `docker compose down -v` also **deletes** the database volume.
- LAN play: `WEB_BIND=0.0.0.0 ALLOWED_ORIGINS=http://<your-ip>:8080 docker compose up --build`

## Develop (one command)

Prerequisites: Node.js 20.19+ (24 LTS recommended), pnpm 10 (`corepack enable`), Docker running.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts PostgreSQL in Docker on `127.0.0.1:5434`, creates `apps/server/.env` from `.env.example` if missing, generates the Prisma client and applies migrations, then runs the API on `:3000` and the web app on **http://localhost:5173**, both with hot reload. Vite proxies `/api` and `/socket.io`, so the browser sees one origin, just like with Nginx.

| Command (repo root) | What it does |
| --- | --- |
| `pnpm dev:server` / `pnpm dev:web` | Run one side only |
| `pnpm db:stop` | Stop the development database (data is kept) |
| `pnpm test` | Server rule tests and web drawing-engine tests (fast, no Docker) |
| `pnpm test:integration` | API, Socket.IO and restart tests against a throwaway PostgreSQL (needs Docker) |
| `pnpm --filter web test:e2e` | Three-browser-context games in Chrome and Edge (needs `pnpm dev` running; uses installed browsers) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Checks and production builds |
| `pnpm load -- --rooms 25 --players 8` | Socket.IO load harness (see `apps/server/scripts/load.ts`) |

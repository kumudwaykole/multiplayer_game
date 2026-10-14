-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'LEFT');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('IN_PROGRESS', 'FINISHED', 'INTERRUPTED');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('CHOOSING', 'DRAWING', 'ENDED');

-- CreateEnum
CREATE TYPE "TurnEndReason" AS ENUM ('TIME_UP', 'ALL_GUESSED', 'DRAWER_DISCONNECTED', 'DRAWER_LEFT', 'NO_GUESSERS', 'NOT_ENOUGH_PLAYERS', 'SERVER_RESTART', 'PERSISTENCE_FAILURE');

-- CreateTable
CREATE TABLE "guest_sessions" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guest_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "hostMembershipId" UUID,
    "status" "RoomStatus" NOT NULL DEFAULT 'OPEN',
    "settings" JSONB NOT NULL,
    "settingsVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "recoveryExpiresAt" TIMESTAMP(3),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "settings" JSONB NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_players" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "rosterPosition" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turns" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "roundIndex" INTEGER NOT NULL,
    "turnIndex" INTEGER NOT NULL,
    "drawerId" UUID NOT NULL,
    "candidates" JSONB NOT NULL,
    "answer" TEXT,
    "status" "TurnStatus" NOT NULL,
    "endReason" "TurnEndReason",
    "startedAt" TIMESTAMP(3) NOT NULL,
    "drawingStartedAt" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "durationMs" INTEGER,
    "endedAt" TIMESTAMP(3),
    "finalCanvasSeq" INTEGER,

    CONSTRAINT "turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guess_awards" (
    "id" UUID NOT NULL,
    "turnId" UUID NOT NULL,
    "gamePlayerId" UUID NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "points" INTEGER NOT NULL,

    CONSTRAINT "guess_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_operations" (
    "turnId" UUID NOT NULL,
    "canvasSeq" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "elapsedMs" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "drawing_operations_pkey" PRIMARY KEY ("turnId","canvasSeq")
);

-- CreateTable
CREATE TABLE "turn_finalizations" (
    "turnId" UUID NOT NULL,
    "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "drawerPoints" INTEGER NOT NULL,

    CONSTRAINT "turn_finalizations_pkey" PRIMARY KEY ("turnId")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_sessions_tokenHash_key" ON "guest_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "guest_sessions_expiresAt_idx" ON "guest_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_code_key" ON "rooms"("code");

-- CreateIndex
CREATE INDEX "rooms_status_idleExpiresAt_idx" ON "rooms"("status", "idleExpiresAt");

-- CreateIndex
CREATE INDEX "memberships_roomId_idx" ON "memberships"("roomId");

-- CreateIndex
CREATE INDEX "memberships_sessionId_idx" ON "memberships"("sessionId");

-- CreateIndex
CREATE INDEX "memberships_recoveryExpiresAt_idx" ON "memberships"("recoveryExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_roomId_sessionId_key" ON "memberships"("roomId", "sessionId");

-- CreateIndex
CREATE INDEX "games_roomId_startedAt_idx" ON "games"("roomId", "startedAt");

-- CreateIndex
CREATE INDEX "games_status_endedAt_idx" ON "games"("status", "endedAt");

-- CreateIndex
CREATE INDEX "game_players_membershipId_idx" ON "game_players"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "game_players_gameId_membershipId_key" ON "game_players"("gameId", "membershipId");

-- CreateIndex
CREATE INDEX "turns_status_idx" ON "turns"("status");

-- CreateIndex
CREATE INDEX "turns_drawerId_idx" ON "turns"("drawerId");

-- CreateIndex
CREATE UNIQUE INDEX "turns_gameId_turnIndex_key" ON "turns"("gameId", "turnIndex");

-- CreateIndex
CREATE INDEX "guess_awards_gamePlayerId_idx" ON "guess_awards"("gamePlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "guess_awards_turnId_gamePlayerId_key" ON "guess_awards"("turnId", "gamePlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "drawing_operations_turnId_commandId_key" ON "drawing_operations"("turnId", "commandId");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "guest_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turns" ADD CONSTRAINT "turns_drawerId_fkey" FOREIGN KEY ("drawerId") REFERENCES "game_players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guess_awards" ADD CONSTRAINT "guess_awards_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guess_awards" ADD CONSTRAINT "guess_awards_gamePlayerId_fkey" FOREIGN KEY ("gamePlayerId") REFERENCES "game_players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drawing_operations" ADD CONSTRAINT "drawing_operations_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "turn_finalizations" ADD CONSTRAINT "turn_finalizations_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "turns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

import type { Logger } from 'pino';
import type { Clock } from '../lib/clock.js';
import type { Metrics } from '../observability/metrics.js';
import type { DrawingSink } from '../persistence/drawingWriter.js';
import type { RoomTransport } from '../realtime/transport.js';
import type { GameRepository } from './repository.js';
import { RoomRuntime, type RoomConfig } from './room.js';

export interface RoomManagerDeps {
  repo: GameRepository;
  writer: DrawingSink;
  clock: Clock;
  logger: Logger;
  metrics?: Metrics;
  config: RoomConfig;
}

/**
 * Owns the in-memory runtime for each open room. Rooms are loaded lazily
 * from PostgreSQL on first use, so after a restart they come back in the
 * lobby with their memberships.
 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly loading = new Map<string, Promise<RoomRuntime | null>>();
  private transport: RoomTransport | null = null;

  constructor(private readonly deps: RoomManagerDeps) {}

  /** Set once Socket.IO is attached (the HTTP server must exist first). */
  attachTransport(transport: RoomTransport): void {
    this.transport = transport;
  }

  get size(): number {
    return this.rooms.size;
  }

  get(code: string): Promise<RoomRuntime | null> {
    const loaded = this.rooms.get(code);
    if (loaded) return Promise.resolve(loaded);
    const pending = this.loading.get(code);
    if (pending) return pending;
    const promise = this.load(code).finally(() => this.loading.delete(code));
    this.loading.set(code, promise);
    return promise;
  }

  /** Recovery heartbeat: while connected, a member's recovery window keeps moving forward. */
  async heartbeat(): Promise<void> {
    const ids: string[] = [];
    for (const room of this.rooms.values()) ids.push(...room.onlineMemberIds());
    if (ids.length === 0) return;
    const expiresAt = new Date(this.deps.clock.wallNow() + this.deps.config.graceMs);
    await this.deps.repo.setRecoveryExpiry(ids, expiresAt);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.rooms.values()].map((room) => room.shutdown()));
  }

  /** Abandons every room without persisting (used to simulate a crash in tests). */
  dispose(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
  }

  loadedRoomIds(): string[] {
    return [...this.rooms.values()].map((room) => room.id);
  }

  stats(): { rooms: number; queuedCommands: number } {
    let queuedCommands = 0;
    for (const room of this.rooms.values()) queuedCommands += room.queueDepth;
    return { rooms: this.rooms.size, queuedCommands };
  }

  private async load(code: string): Promise<RoomRuntime | null> {
    if (!this.transport) throw new Error('RoomManager used before a transport was attached');
    const loaded = await this.deps.repo.loadRoom(code);
    if (!loaded || loaded.status !== 'OPEN') return null;
    const existing = this.rooms.get(code);
    if (existing) return existing;
    const room = new RoomRuntime(loaded, {
      ...this.deps,
      transport: this.transport,
      onClosed: (closed) => {
        if (this.rooms.get(closed.code) === closed) this.rooms.delete(closed.code);
        this.deps.logger.info({ room: closed.code }, 'room closed after idle timeout');
      },
    });
    this.rooms.set(code, room);
    return room;
  }
}

import type { RoomTransport } from '../../src/realtime/transport.js';

export interface Received {
  event: string;
  payload: unknown;
}

/** Records what each socket would receive, including channel broadcasts. */
export class FakeTransport implements RoomTransport {
  private readonly channels = new Map<string, Set<string>>();
  private readonly inbox = new Map<string, Received[]>();
  readonly broadcasts: Array<{ channel: string } & Received> = [];

  broadcast(channel: string, event: string, payload: unknown): void {
    const copy = structuredClone(payload);
    this.broadcasts.push({ channel, event, payload: copy });
    for (const socketId of this.channels.get(channel) ?? []) this.deliver(socketId, event, copy);
  }

  emitToSocket(socketId: string, event: string, payload: unknown): void {
    this.deliver(socketId, event, structuredClone(payload));
  }

  joinChannel(socketId: string, channel: string): void {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Set();
      this.channels.set(channel, members);
    }
    members.add(socketId);
  }

  leaveChannel(socketId: string, channel: string): void {
    this.channels.get(channel)?.delete(socketId);
  }

  /** Simulates the socket going away (Socket.IO removes it from every room). */
  drop(socketId: string): void {
    for (const members of this.channels.values()) members.delete(socketId);
  }

  received(socketId: string, event?: string): Received[] {
    const all = this.inbox.get(socketId) ?? [];
    return event ? all.filter((r) => r.event === event) : all;
  }

  last<T>(socketId: string, event: string): T | undefined {
    return this.received(socketId, event).at(-1)?.payload as T | undefined;
  }

  private deliver(socketId: string, event: string, payload: unknown): void {
    let list = this.inbox.get(socketId);
    if (!list) {
      list = [];
      this.inbox.set(socketId, list);
    }
    list.push({ event, payload });
  }
}

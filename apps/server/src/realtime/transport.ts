import type { Server } from 'socket.io';

/** How the room runtime reaches sockets. Lets rule tests run without Socket.IO. */
export interface RoomTransport {
  broadcast(channel: string, event: string, payload: unknown): void;
  emitToSocket(socketId: string, event: string, payload: unknown): void;
  joinChannel(socketId: string, channel: string): void;
  leaveChannel(socketId: string, channel: string): void;
}

export class SocketIoTransport implements RoomTransport {
  constructor(private readonly io: Server) {}

  broadcast(channel: string, event: string, payload: unknown): void {
    this.io.to(channel).emit(event, payload);
  }

  emitToSocket(socketId: string, event: string, payload: unknown): void {
    this.io.sockets.sockets.get(socketId)?.emit(event, payload);
  }

  joinChannel(socketId: string, channel: string): void {
    void this.io.sockets.sockets.get(socketId)?.join(channel);
  }

  leaveChannel(socketId: string, channel: string): void {
    void this.io.sockets.sockets.get(socketId)?.leave(channel);
  }
}

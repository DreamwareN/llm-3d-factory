import { PROTOCOL_VERSION } from '@llm3d/shared/version';
import type { ClientMessage, ServerMessage } from '@llm3d/shared';

type ClientPayload = ClientMessage extends infer T
  ? T extends ClientMessage
    ? Omit<T, 'v' | 'id' | 'ts'>
    : never
  : never;

export type WsStatus = 'connecting' | 'open' | 'closed';

class WsClient {
  private socket: WebSocket | null = null;
  private readonly messageHandlers = new Set<(message: ServerMessage) => void>();
  private readonly statusHandlers = new Set<(status: WsStatus) => void>();
  private queue: ClientPayload[] = [];
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private status: WsStatus = 'closed';

  connect(): void {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const base =
      import.meta.env.VITE_WS_BASE ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
    this.setStatus('connecting');
    const socket = new WebSocket(`${base}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus('open');
      const pending = this.queue;
      this.queue = [];
      for (const payload of pending) this.rawSend(payload);
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(message);
    };
    socket.onclose = () => {
      this.setStatus('closed');
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (status: WsStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  send(payload: ClientPayload): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.rawSend(payload);
    } else {
      this.queue.push(payload);
      this.connect();
    }
  }

  private rawSend(payload: ClientPayload): void {
    this.socket?.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        ts: Date.now(),
        ...payload,
      }),
    );
  }

  private setStatus(status: WsStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler(status);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(5000, 400 * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export const ws = new WsClient();

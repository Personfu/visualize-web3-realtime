import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { ExecutorAccess, executorProtocol } from './ExecutorAccess.js';
import type { AgentEvent, AgentIdentity, AgentTask, ExecutorState } from './types.js';
import type { BroadcastMessage } from './types.js';

interface ClientState {
  ws: WebSocket;
  /** If set, only forward events matching these agent IDs */
  subscribedAgents: Set<string> | null;
}

export class EventBroadcaster {
  private wss?: WebSocketServer;
  private standaloneServer?: HttpServer;
  private httpServer?: HttpServer;
  private upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private clients = new Map<WebSocket, ClientState>();
  private recentEvents: AgentEvent[] = [];

  constructor(private readonly port: number, private readonly access: ExecutorAccess) {}

  start(
    getSnapshot: () => { agents: AgentIdentity[]; tasks: AgentTask[]; recentEvents: AgentEvent[] },
    httpServer?: HttpServer,
  ): void {
    if (this.wss) throw new Error('Event broadcaster is already running');
    const server = httpServer ?? createServer((_, response) => response.writeHead(404).end());
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
      handleProtocols: protocols => protocols.has(executorProtocol) ? executorProtocol : false,
    });
    this.wss = wss;
    this.httpServer = server;
    this.upgrade = (request, socket, head) => {
      if (!this.access.authorizeWebSocket(request)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: private, no-store\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
        return;
      }
      wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client));
    };
    server.on('upgrade', this.upgrade);
    if (!httpServer) {
      this.standaloneServer = server;
      server.listen(this.port, '127.0.0.1');
    }
    wss.on('connection', (ws: WebSocket) => {
      const state: ClientState = { ws, subscribedAgents: null };
      this.clients.set(ws, state);

      // Send snapshot on connect
      const snapshot: BroadcastMessage = { type: 'snapshot', data: getSnapshot() };
      ws.send(JSON.stringify(snapshot));

      // Handle client messages (e.g., subscribe)
      ws.on('message', (raw: Buffer | string) => {
        try {
          const msg: unknown = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
          if (!msg || typeof msg !== 'object' || !('type' in msg) || !('agentIds' in msg)) return;
          if (msg.type === 'subscribe' && Array.isArray(msg.agentIds) && msg.agentIds.length <= 1000 &&
              msg.agentIds.every(id => typeof id === 'string' && id.length <= 128)) {
            state.subscribedAgents = new Set<string>(msg.agentIds);
          } else if (msg.type === 'subscribe' && msg.agentIds === null) {
            // Unsubscribe — receive all events again
            state.subscribedAgents = null;
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });

    console.log(`[EventBroadcaster] WebSocket server listening on port ${this.port}`);
  }

  broadcast(event: AgentEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 500) this.recentEvents = this.recentEvents.slice(-500);

    const msg: BroadcastMessage = { type: 'event', data: event };
    const json = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (client.ws.readyState !== 1 /* OPEN */) continue;
      // Apply subscription filter
      if (client.subscribedAgents && !client.subscribedAgents.has(event.agentId)) continue;
      client.ws.send(json);
    }
  }

  broadcastState(state: ExecutorState): void {
    const msg: BroadcastMessage = { type: 'heartbeat', data: state };
    const json = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) {
        // Heartbeat always sent regardless of subscription filter
        client.ws.send(json);
      }
    }
  }

  getClientCount(): number { return this.clients.size; }

  stop(): void {
    for (const [, client] of this.clients) {
      client.ws.terminate();
    }
    this.clients.clear();
    if (this.upgrade) this.httpServer?.off('upgrade', this.upgrade);
    this.wss?.close();
    this.standaloneServer?.close();
    this.wss = undefined;
    this.httpServer = undefined;
    this.standaloneServer = undefined;
    this.upgrade = undefined;
  }
}

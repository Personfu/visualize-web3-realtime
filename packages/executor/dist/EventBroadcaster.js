import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { executorProtocol } from './ExecutorAccess.js';
export class EventBroadcaster {
    port;
    access;
    wss;
    standaloneServer;
    httpServer;
    upgrade;
    clients = new Map();
    recentEvents = [];
    constructor(port, access) {
        this.port = port;
        this.access = access;
    }
    start(getSnapshot, httpServer) {
        if (this.wss)
            throw new Error('Event broadcaster is already running');
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
        wss.on('connection', (ws) => {
            const state = { ws, subscribedAgents: null };
            this.clients.set(ws, state);
            // Send snapshot on connect
            const snapshot = { type: 'snapshot', data: getSnapshot() };
            ws.send(JSON.stringify(snapshot));
            // Handle client messages (e.g., subscribe)
            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
                    if (!msg || typeof msg !== 'object' || !('type' in msg) || !('agentIds' in msg))
                        return;
                    if (msg.type === 'subscribe' && Array.isArray(msg.agentIds) && msg.agentIds.length <= 1000 &&
                        msg.agentIds.every(id => typeof id === 'string' && id.length <= 128)) {
                        state.subscribedAgents = new Set(msg.agentIds);
                    }
                    else if (msg.type === 'subscribe' && msg.agentIds === null) {
                        // Unsubscribe — receive all events again
                        state.subscribedAgents = null;
                    }
                }
                catch {
                    // ignore malformed messages
                }
            });
            ws.on('close', () => this.clients.delete(ws));
            ws.on('error', () => this.clients.delete(ws));
        });
        console.log(`[EventBroadcaster] WebSocket server listening on port ${this.port}`);
    }
    broadcast(event) {
        this.recentEvents.push(event);
        if (this.recentEvents.length > 500)
            this.recentEvents = this.recentEvents.slice(-500);
        const msg = { type: 'event', data: event };
        const json = JSON.stringify(msg);
        for (const [, client] of this.clients) {
            if (client.ws.readyState !== 1 /* OPEN */)
                continue;
            // Apply subscription filter
            if (client.subscribedAgents && !client.subscribedAgents.has(event.agentId))
                continue;
            client.ws.send(json);
        }
    }
    broadcastState(state) {
        const msg = { type: 'heartbeat', data: state };
        const json = JSON.stringify(msg);
        for (const [, client] of this.clients) {
            if (client.ws.readyState === 1) {
                // Heartbeat always sent regardless of subscription filter
                client.ws.send(json);
            }
        }
    }
    getClientCount() { return this.clients.size; }
    stop() {
        for (const [, client] of this.clients) {
            client.ws.terminate();
        }
        this.clients.clear();
        if (this.upgrade)
            this.httpServer?.off('upgrade', this.upgrade);
        this.wss?.close();
        this.standaloneServer?.close();
        this.wss = undefined;
        this.httpServer = undefined;
        this.standaloneServer = undefined;
        this.upgrade = undefined;
    }
}

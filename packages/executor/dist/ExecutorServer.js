import { createServer } from 'node:http';
import { ExecutorAccess } from './ExecutorAccess.js';
import { createExecutorRestHandler } from './ExecutorRest.js';
import { TaskQueue } from './TaskQueue.js';
import { AgentManager } from './AgentManager.js';
import { EventBroadcaster } from './EventBroadcaster.js';
import { HealthMonitor } from './HealthMonitor.js';
import { SperaxOSClient } from './SperaxOSClient.js';
import { StateStore } from './StateStore.js';
export const DEFAULT_AGENT_ROLES = ['coder', 'researcher', 'planner'];
export class ExecutorServer {
    config;
    access;
    handleRest;
    queue;
    agentManager;
    broadcaster;
    health;
    speraxos;
    stateStore;
    startedAt = 0;
    running = false;
    pollTimer;
    heartbeatTimer;
    httpServer;
    recentEvents = [];
    constructor(config) {
        this.config = config;
        // Validate inbound authority before any upstream client or state store is created.
        this.access = new ExecutorAccess(config.accessToken, config.allowedOrigins, config.viewerToken);
        this.speraxos = new SperaxOSClient(config.speraxosUrl, config.speraxosApiKey);
        this.queue = new TaskQueue();
        this.agentManager = new AgentManager(this.speraxos);
        this.broadcaster = new EventBroadcaster(config.port, this.access);
        this.health = new HealthMonitor();
        this.stateStore = new StateStore(config.statePath);
        // Forward agent events to broadcaster and state store
        this.agentManager.onEvent((event) => {
            this.recentEvents.push(event);
            if (this.recentEvents.length > 500)
                this.recentEvents = this.recentEvents.slice(-500);
            this.broadcaster.broadcast(event);
            this.stateStore.saveEvent(event);
            // Sync task completion/failure back to the queue
            if (event.type === 'task:completed' && event.taskId) {
                this.queue.complete(event.taskId, String(event.payload.result ?? ''));
                const tasks = this.queue.getAll();
                const task = tasks.find((t) => t.taskId === event.taskId);
                if (task)
                    this.stateStore.saveTask(task);
            }
            else if (event.type === 'task:failed' && event.taskId) {
                this.queue.fail(event.taskId, String(event.payload.error ?? 'Unknown error'));
                const tasks = this.queue.getAll();
                const task = tasks.find((t) => t.taskId === event.taskId);
                if (task)
                    this.stateStore.saveTask(task);
            }
        });
        this.handleRest = createExecutorRestHandler(this.access, {
            getStatus: () => this.getStatus(),
            getHealth: () => this.health.getHealth(),
            getAgents: () => this.agentManager.getActiveAgents(),
            getTasks: () => this.queue.getAll(),
            enqueueTask: definition => this.enqueueTask(definition),
            spawnAgent: config => this.agentManager.spawnAgent(config),
            saveAgent: agent => this.stateStore.saveAgent(agent),
            stopAgent: agentId => this.agentManager.shutdownAgent(agentId),
        });
        this.setupHealthChecks();
    }
    setupHealthChecks() {
        this.health.addCheck('speraxos', () => ({
            name: 'speraxos',
            status: this.config.speraxosApiKey ? 'warn' : 'pass',
            message: this.config.speraxosApiKey ? 'Upstream connectivity has not been verified' : 'Synthetic mock mode; no upstream connection',
            timestamp: Date.now(),
        }));
        this.health.addCheck('queue', () => {
            const stats = this.queue.getStats();
            const status = stats.queued > 100 ? 'warn' : 'pass';
            return {
                name: 'queue',
                status: status,
                message: `Queue depth: ${stats.queued}`,
                timestamp: Date.now(),
            };
        });
        this.health.addCheck('agents', () => {
            const count = this.agentManager.getAgentCount();
            return {
                name: 'agents',
                status: count === 0 ? 'warn' : 'pass',
                message: `${count} active agents`,
                timestamp: Date.now(),
            };
        });
        this.health.addCheck('memory', () => {
            const usage = process.memoryUsage();
            const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
            const threshold = 512; // MB
            return {
                name: 'memory',
                status: heapMB > threshold ? 'warn' : 'pass',
                message: `Heap: ${heapMB}MB`,
                timestamp: Date.now(),
            };
        });
        this.health.addCheck('event_rate', () => {
            const recentCount = this.recentEvents.length;
            const now = Date.now();
            // Check if events have flowed in the last 2 minutes (only warn if agents are active)
            const twoMinAgo = now - 120_000;
            const recentEventsInWindow = this.recentEvents.filter((e) => e.timestamp > twoMinAgo).length;
            const agentCount = this.agentManager.getAgentCount();
            const stuck = agentCount > 0 && recentEventsInWindow === 0 && this.running && (now - this.startedAt > 120_000);
            return {
                name: 'event_rate',
                status: stuck ? 'warn' : 'pass',
                message: `${recentEventsInWindow} events in last 2min (total buffered: ${recentCount})`,
                timestamp: now,
            };
        });
    }
    async start() {
        this.startedAt = Date.now();
        this.running = true;
        console.log('[ExecutorServer] Starting...');
        // Initialize state store metadata
        this.stateStore.setMeta('start_time', String(this.startedAt));
        // Restore persisted tasks from previous run
        const restoredTasks = this.stateStore.loadActiveTasks();
        for (const task of restoredTasks) {
            // Re-enqueue tasks that were queued or in-progress (stalled) before crash
            this.queue.enqueue({ description: task.description, priority: task.priority, requiredRole: undefined }, '');
            console.log(`[ExecutorServer] Restored task: ${task.taskId} (${task.status})`);
        }
        // Load recent events for snapshot
        this.recentEvents = this.stateStore.loadRecentEvents(50);
        // Start HTTP server (shared by both REST API and WebSocket)
        this.httpServer = createServer((req, res) => {
            // Only handle REST API requests here (non-upgrade requests)
            if (!req.url || !req.url.startsWith('/')) {
                res.writeHead(404);
                res.end();
                return;
            }
            this.handleRest(req, res);
        });
        // Start WebSocket server on the same HTTP server
        this.broadcaster.start(() => ({
            agents: this.agentManager.getActiveAgents(),
            tasks: this.queue.getAll(),
            recentEvents: this.recentEvents.slice(-50),
        }), this.httpServer);
        // Listen on the shared HTTP server
        this.httpServer.requestTimeout = 30_000;
        this.httpServer.headersTimeout = 15_000;
        this.httpServer.listen(this.config.port, this.config.host ?? '127.0.0.1', () => {
            console.log(`[ExecutorServer] Ready on http://localhost:${this.config.port} (REST API + WebSocket)`);
        });
        // Spawn initial agents
        const agentCount = Math.min(this.config.maxAgents, DEFAULT_AGENT_ROLES.length);
        for (let i = 0; i < agentCount; i++) {
            const agent = await this.agentManager.spawnAgent({
                role: DEFAULT_AGENT_ROLES[i],
                name: `${DEFAULT_AGENT_ROLES[i].charAt(0).toUpperCase()}${DEFAULT_AGENT_ROLES[i].slice(1)}Agent`,
            });
            this.stateStore.saveAgent(agent);
        }
        // Start task processing loop
        this.pollTimer = setInterval(() => this.processTasks(), this.config.taskPollInterval);
        // Start heartbeat
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.config.heartbeatInterval);
        // Start health monitoring
        this.health.start();
        console.log(`[ExecutorServer] Ready. WS port: ${this.config.port}`);
    }
    async processTasks() {
        if (!this.running)
            return;
        // Check stalled tasks
        this.queue.checkTimeouts();
        // Auto-scale agents
        const queueLength = this.queue.getQueueLength();
        await this.agentManager.autoScale(queueLength, this.config.maxAgents);
        // Assign queued tasks to available agents
        if (queueLength === 0)
            return;
        const agent = this.agentManager.getAvailableAgent();
        if (!agent)
            return;
        const task = this.queue.dequeue(agent.role);
        if (!task)
            return;
        task.agentId = agent.agentId;
        try {
            await this.agentManager.assignTask(task);
            // Persist task to state store after assignment
            this.stateStore.saveTask(task);
        }
        catch {
            console.error('[ExecutorServer] Task assignment failed');
            this.queue.fail(task.taskId, 'Task assignment failed');
        }
    }
    sendHeartbeat() {
        const state = {
            executorId: 'executor-01',
            status: 'running',
            activeAgents: this.agentManager.getActiveAgents(),
            uptime: Date.now() - this.startedAt,
            totalTasksProcessed: this.queue.getStats().completed + this.queue.getStats().failed,
            totalToolCalls: 0,
            lastHeartbeat: Date.now(),
        };
        this.broadcaster.broadcastState(state);
        // Also emit as AgentEvent for frontend hook compatibility
        const hbEvent = {
            eventId: `hb_${Date.now()}`,
            type: 'heartbeat',
            timestamp: Date.now(),
            agentId: 'executor',
            payload: {
                activeAgents: this.agentManager.getAgentCount(),
                uptime: Date.now() - this.startedAt,
                totalTasksProcessed: this.queue.getStats().completed,
            },
        };
        this.broadcaster.broadcast(hbEvent);
    }
    enqueueTask(definition) {
        const taskId = this.queue.enqueue(definition);
        const tasks = this.queue.getAll();
        const task = tasks.find((t) => t.taskId === taskId);
        if (task) {
            this.stateStore.saveTask(task);
        }
        return taskId;
    }
    getStatus() {
        return {
            executorId: 'executor-01',
            status: this.running ? 'running' : 'stopped',
            activeAgents: this.agentManager.getActiveAgents(),
            uptime: Date.now() - this.startedAt,
            totalTasksProcessed: this.queue.getStats().completed + this.queue.getStats().failed,
            totalToolCalls: 0,
            lastHeartbeat: Date.now(),
        };
    }
    async stop() {
        this.running = false;
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        if (this.heartbeatTimer)
            clearInterval(this.heartbeatTimer);
        this.health.stop();
        this.broadcaster.stop();
        // Close HTTP server
        if (this.httpServer) {
            await new Promise((resolve) => {
                this.httpServer.close(() => resolve());
            });
        }
        // Close state store
        this.stateStore.close();
        console.log('[ExecutorServer] Stopped.');
    }
}

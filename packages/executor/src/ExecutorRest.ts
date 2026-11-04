import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { AgentIdentity, AgentSpawnConfig, AgentTask, ExecutorState, TaskDefinition } from './types.js';
import type { HealthMonitor } from './HealthMonitor.js';
import type { ExecutorAccess } from './ExecutorAccess.js';
import { readRequestBody, rejectRequestBody } from './requestBody.js';

export interface ExecutorRestServices {
  getStatus(): ExecutorState;
  getHealth(): ReturnType<HealthMonitor['getHealth']>;
  getAgents(): AgentIdentity[];
  getTasks(): AgentTask[];
  enqueueTask(definition: TaskDefinition): string;
  spawnAgent(config: AgentSpawnConfig): Promise<AgentIdentity>;
  saveAgent(agent: AgentIdentity): void;
  stopAgent(agentId: string): Promise<void>;
}

export function createExecutorRestHandler(access: ExecutorAccess, services: ExecutorRestServices) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!access.authorizeHttp(req, res)) return;
    const url = new URL(req.url!, 'http://executor.invalid');
    const path = url.pathname;
    const method = req.method;

    // Route matching
    if (path === '/api/status' && method === 'GET') {
      const state = services.getStatus();
      const health = services.getHealth();
      res.writeHead(200);
      res.end(JSON.stringify({ state, health }));
    } else if (path === '/api/agents' && method === 'GET') {
      const agents = services.getAgents();
      res.writeHead(200);
      res.end(JSON.stringify(agents));
    } else if (path === '/api/tasks' && method === 'GET') {
      const tasks = services.getTasks();
      res.writeHead(200);
      res.end(JSON.stringify(tasks));
    } else if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'GET') {
      const taskId = path.split('/').pop();
      const tasks = services.getTasks();
      const task = tasks.find((t) => t.taskId === taskId);
      if (task) {
        res.writeHead(200);
        res.end(JSON.stringify(task));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Task not found' }));
      }
    } else if (path === '/api/tasks' && method === 'POST') {
      readRequestBody(req)
        .then((body: Record<string, unknown>) => {
          const definition: TaskDefinition = {
            description: String(body.description || 'Unnamed task'),
            priority: typeof body.priority === 'number' ? body.priority : undefined,
            requiredRole: typeof body.requiredRole === 'string' ? body.requiredRole : undefined,
            timeout: typeof body.timeout === 'number' ? body.timeout : undefined,
            retryCount: typeof body.retryCount === 'number' ? body.retryCount : undefined,
            metadata: typeof body.metadata === 'object' && body.metadata !== null ? (body.metadata as Record<string, unknown>) : undefined,
          };
          const taskId = services.enqueueTask(definition);
          res.writeHead(201);
          res.end(JSON.stringify({ taskId }));
        })
        .catch((error: unknown) => rejectRequestBody(req, res, error));
    } else if (path.match(/^\/api\/tasks\/[^/]+$/) && method === 'DELETE') {
      res.writeHead(501);
      res.end(JSON.stringify({ error: 'Task cancellation not yet implemented' }));
    } else if (path === '/api/agents/spawn' && method === 'POST') {
      readRequestBody(req)
        .then((body: Record<string, unknown>) => {
          services.spawnAgent({ role: String(body.role || 'coder'), name: String(body.name || '') })
            .then((agent) => {
              services.saveAgent(agent);
              res.writeHead(201);
              res.end(JSON.stringify(agent));
            })
            .catch(() => {
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Agent operation failed' }));
            });
        })
        .catch((error: unknown) => rejectRequestBody(req, res, error));
    } else if (path.match(/^\/api\/agents\/[^/]+\/stop$/) && method === 'POST') {
      const agentId = path.split('/').slice(-2, -1)[0];
      services.stopAgent(agentId)
        .then(() => {
          res.writeHead(200);
          res.end(JSON.stringify({ agentId, status: 'stopped' }));
        })
        .catch(() => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Agent operation failed' }));
        });
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  };
}

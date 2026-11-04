'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentEvent, AgentIdentity, AgentFlowTrace, AgentToolCall } from '@web3viz/core';
import type { AgentAggregateStats, UseAgentEventsReturn } from './useAgentEvents';

const AGENT_PROFILES: Array<{ name: string; role: string }> = [
  { name: 'CodeReviewer', role: 'coder' },
  { name: 'Researcher', role: 'researcher' },
  { name: 'Planner', role: 'planner' },
  { name: 'TypeChecker', role: 'coder' },
  { name: 'DocWriter', role: 'researcher' },
];

const TASK_DESCRIPTIONS = [
  'Review pull request #42',
  'Analyze API documentation',
  'Plan sprint backlog',
  'Search for relevant papers',
  'Refactor authentication module',
  'Generate test coverage report',
  'Audit security vulnerabilities',
  'Optimize database queries',
  'Update dependency versions',
  'Write technical specification',
];

const TOOL_CALLS: Array<{ toolName: string; toolCategory: AgentToolCall['toolCategory']; inputSummary: string }> = [
  { toolName: 'read_file', toolCategory: 'filesystem', inputSummary: 'Reading src/index.ts' },
  { toolName: 'grep_search', toolCategory: 'search', inputSummary: 'Searching for "handleSubmit"' },
  { toolName: 'run_in_terminal', toolCategory: 'terminal', inputSummary: 'npx tsc --noEmit' },
  { toolName: 'semantic_search', toolCategory: 'search', inputSummary: 'Finding authentication patterns' },
  { toolName: 'create_file', toolCategory: 'filesystem', inputSummary: 'Creating src/utils/auth.ts' },
  { toolName: 'fetch_url', toolCategory: 'network', inputSummary: 'GET https://api.example.com/docs' },
  { toolName: 'run_tests', toolCategory: 'terminal', inputSummary: 'npm test -- --coverage' },
  { toolName: 'analyze_code', toolCategory: 'code', inputSummary: 'Analyzing complexity metrics' },
  { toolName: 'think', toolCategory: 'reasoning', inputSummary: 'Reasoning about architecture trade-offs' },
  { toolName: 'list_dir', toolCategory: 'filesystem', inputSummary: 'Listing src/components/' },
];

const REASONING_SNIPPETS = [
  'The form component has a race condition in the submit handler.',
  'Need to check if TypeScript types allow concurrent state updates.',
  'The authentication flow could be simplified by using middleware.',
  'Consider splitting this into smaller, more testable functions.',
  'The database query is doing N+1 selects — should join instead.',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Math.random().toString(36).slice(2, 11);
}

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function emptyFlow(agent: AgentIdentity): AgentFlowTrace {
  return {
    flowId: `flow_${agent.agentId}`,
    agent,
    tasks: [],
    toolCalls: [],
    events: [],
    subAgents: [],
    status: 'active',
    startedAt: agent.createdAt,
    totalToolCalls: 0,
    totalTasksCompleted: 0,
  };
}

export interface UseMockAgentEventsOptions {
  agentCount?: number;
  eventsPerSecond?: number;
  autoStart?: boolean;
}

type Snapshot = Omit<UseAgentEventsReturn, 'connect' | 'disconnect' | 'setPaused'>;
const emptyStats = (): AgentAggregateStats => ({
  totalAgents: 0, activeTasks: 0, totalToolCalls: 0,
  totalTasksCompleted: 0, totalTasksFailed: 0, toolCallsPerMinute: 0,
});
const emptySnapshot = (): Snapshot => ({
  connected: false, paused: false, executorState: null,
  agents: new Map(), flows: new Map(), recentEvents: [], stats: emptyStats(),
});

/** Offline clock-driven demo. It never calls a tool, RPC, or agent service. */
export class MockAgentStore {
  private connected = false;
  private paused = false;
  private agents = new Map<string, AgentIdentity>();
  private flows = new Map<string, AgentFlowTrace>();
  private phases = new Map<string, { phase: string; taskId: string | null; callCount: number; taskCount: number }>();
  private toolCallTimestamps: number[] = [];
  private recentEvents: AgentEvent[] = [];
  private totalFailed = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private deferred: Array<() => void> = [];
  private listeners = new Set<() => void>();
  private snapshot = emptySnapshot();
  private readonly serverSnapshot = emptySnapshot();

  constructor(private readonly agentCount: number, private readonly eventsPerSecond: number) {
    if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > AGENT_PROFILES.length ||
        !Number.isFinite(eventsPerSecond) || eventsPerSecond <= 0 || eventsPerSecond > 60) {
      throw new Error('Invalid offline demo configuration');
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.serverSnapshot;

  private publish() {
    const cutoff = Date.now() - 60_000;
    this.toolCallTimestamps = this.toolCallTimestamps.filter(t => t > cutoff);
    const stats = emptyStats();
    stats.totalAgents = this.agents.size;
    stats.activeTasks = [...this.phases.values()].filter(p => p.phase === 'in-task').length;
    stats.totalTasksFailed = this.totalFailed;
    stats.toolCallsPerMinute = this.toolCallTimestamps.length;
    for (const flow of this.flows.values()) {
      stats.totalToolCalls += flow.totalToolCalls;
      stats.totalTasksCompleted += flow.totalTasksCompleted;
    }
    // Published snapshots cannot change underneath React's concurrent readers.
    this.snapshot = structuredClone({
      connected: this.connected, paused: this.paused, executorState: null,
      agents: this.agents, flows: this.flows, recentEvents: this.recentEvents, stats,
    });
    for (const listener of this.listeners) listener();
  }

  private later(fn: () => void, delay: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.connected) return;
      if (this.paused) this.deferred.push(fn);
      else fn();
    }, delay);
    this.timers.add(timer);
  }

  private emit(event: AgentEvent) {
    if (!this.connected || this.paused) return;
    this.recentEvents = [event, ...this.recentEvents].slice(0, 500);
    const flow = this.flows.get(event.agentId);
    if (!flow) return;
    flow.events = [...flow.events, event].slice(-500);
    if (event.type === 'task:started' && event.taskId) {
      flow.tasks = [...flow.tasks, {
        taskId: event.taskId, agentId: event.agentId,
        description: String(event.payload.description ?? ''),
        status: 'in-progress' as const, createdAt: event.timestamp, startedAt: event.timestamp,
      }].slice(-500);
    } else if (event.type === 'task:completed' || event.type === 'task:failed') {
      flow.tasks = flow.tasks.map(task => task.taskId === event.taskId ? {
        ...task, status: event.type === 'task:completed' ? 'completed' : 'failed', endedAt: event.timestamp,
      } : task);
      if (event.type === 'task:completed') flow.totalTasksCompleted++;
      else this.totalFailed++;
    } else if (event.type === 'tool:started' && event.callId && event.taskId) {
      const category = TOOL_CALLS.find(tool => tool.toolName === event.payload.toolName)?.toolCategory ?? 'other';
      flow.toolCalls = [...flow.toolCalls, {
        callId: event.callId, taskId: event.taskId, agentId: event.agentId,
        toolName: String(event.payload.toolName ?? ''), toolCategory: category,
        inputSummary: String(event.payload.inputSummary ?? ''), status: 'started' as const, startedAt: event.timestamp,
      }].slice(-500);
      flow.totalToolCalls++;
    } else if (event.type === 'tool:completed' || event.type === 'tool:failed') {
      flow.toolCalls = flow.toolCalls.map(call => call.callId === event.callId ? {
        ...call, status: event.type === 'tool:completed' ? 'completed' : 'failed',
        endedAt: event.timestamp, duration: event.timestamp - call.startedAt,
        outputSummary: String(event.payload.outputSummary ?? ''),
      } : call);
    } else if (event.type === 'subagent:spawn' && typeof event.payload.subAgentId === 'string') {
      const child = this.agents.get(event.payload.subAgentId);
      if (child) flow.subAgents.push(child);
    }
    this.publish();
  }

  private tick = () => {
    if (!this.connected || this.paused) return;
    const now = Date.now();
    const agentIds = Array.from(this.agents.keys());

    for (const agentId of agentIds) {
      const phase = this.phases.get(agentId);
      if (!phase) continue;

      // Random chance to advance state each tick
      const roll = Math.random();

      if (phase.phase === 'idle') {
        if (roll < 0.3) {
          // Start a new task
          const taskId = `task_${uid()}`;
          phase.phase = 'in-task';
          phase.taskId = taskId;
          phase.callCount = 0;

          const taskEvent: AgentEvent = {
            eventId: `evt_${uid()}`,
            type: 'task:started',
            timestamp: now,
            agentId,
            taskId,
            payload: {
              description: randomFrom(TASK_DESCRIPTIONS),
              priority: Math.floor(Math.random() * 5),
            },
          };
          this.emit(taskEvent);

          // Occasionally spawn a sub-agent (20%)
          if (roll < 0.06 && this.agents.size < this.agentCount + 2) {
            const subId = `agent_sub_${uid()}`;
            const profile = randomFrom(AGENT_PROFILES);
            const subIdentity: AgentIdentity = {
              agentId: subId,
              name: `${profile.name}Helper`,
              role: profile.role,
              parentAgentId: agentId,
              createdAt: now,
            };
            this.agents.set(subId, subIdentity);
            this.phases.set(subId, { phase: 'idle', taskId: null, callCount: 0, taskCount: 0 });
            this.flows.set(subId, emptyFlow(subIdentity));

            this.emit({
              eventId: `evt_${uid()}`,
              type: 'subagent:spawn',
              timestamp: now,
              agentId,
              taskId,
              payload: { subAgentId: subId, name: subIdentity.name, role: subIdentity.role },
            });
          }
        }
      } else if (phase.phase === 'in-task') {
        if (phase.taskId === null) {
          phase.phase = 'idle';
          continue;
        }

        const maxCalls = 3 + Math.floor(Math.random() * 6);

        if (phase.callCount < maxCalls && roll < 0.5) {
          // Make a tool call
          const tool = randomFrom(TOOL_CALLS);
          const callId = `call_${uid()}`;
          phase.callCount += 1;

          this.toolCallTimestamps.push(now);

          this.emit({
            eventId: `evt_${uid()}`,
            type: 'tool:started',
            timestamp: now,
            agentId,
            taskId: phase.taskId,
            callId,
            payload: {
              toolName: tool.toolName,
              toolCategory: tool.toolCategory,
              inputSummary: tool.inputSummary,
              callId,
            },
          });

          const callTaskId = phase.taskId;
          // Complete the tool call shortly after
          this.later(() => {
            if (this.paused) return;
            const success = Math.random() > 0.1;
            this.emit({
              eventId: `evt_${uid()}`,
              type: success ? 'tool:completed' : 'tool:failed',
              timestamp: Date.now(),
              agentId,
              taskId: callTaskId,
              callId,
              payload: {
                callId,
                outputSummary: success ? 'Done.' : 'Error: timeout',
              },
            });
          }, 200 + Math.random() * 800);

          // Occasionally emit reasoning
          if (roll < 0.1) {
            this.emit({
              eventId: `evt_${uid()}`,
              type: 'reasoning:update',
              timestamp: now,
              agentId,
              taskId: phase.taskId,
              payload: { text: randomFrom(REASONING_SNIPPETS) },
            });
          }
        } else if (phase.callCount >= maxCalls || roll > 0.9) {
          // Complete or fail the task
          const failed = Math.random() < 0.1;
          phase.taskCount += 1;

          this.emit({
            eventId: `evt_${uid()}`,
            type: failed ? 'task:failed' : 'task:completed',
            timestamp: now,
            agentId,
            taskId: phase.taskId,
            payload: failed
              ? { error: 'Task timed out after maximum retries' }
              : { result: 'Task completed successfully' },
          });

          phase.phase = 'idle';
          phase.taskId = null;
        }
      }
    }


    this.publish();
  };

  connect = () => {
    if (this.connected) return;
    this.connected = true;
    const now = Date.now();
    for (let i = 0; i < this.agentCount; i++) {
      const profile = AGENT_PROFILES[i];
      const agentId = `agent_${i.toString().padStart(3, '0')}`;
      const identity: AgentIdentity = { agentId, name: profile.name, role: profile.role, createdAt: now };
      this.agents.set(agentId, identity);
      this.flows.set(agentId, emptyFlow(identity));
      this.phases.set(agentId, { phase: 'idle', taskId: null, callCount: 0, taskCount: 0 });
      this.later(() => this.emit({
        eventId: `evt_spawn_${agentId}`, type: 'agent:spawn', timestamp: now + i * 100,
        agentId, payload: { name: profile.name, role: profile.role },
      }), i * 200);
    }
    this.interval = setInterval(this.tick, 1000 / this.eventsPerSecond);
    this.publish();
  };

  disconnect = () => {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.deferred = [];
    this.connected = false;
    this.agents.clear();
    this.flows.clear();
    this.phases.clear();
    this.toolCallTimestamps = [];
    this.recentEvents = [];
    this.totalFailed = 0;
    this.publish();
  };

  setPaused = (paused: boolean) => {
    this.paused = paused;
    if (!paused && this.connected) {
      const pending = this.deferred;
      this.deferred = [];
      for (const complete of pending) complete();
    }
    this.publish();
  };
}

export function useAgentEventsMock(options: UseMockAgentEventsOptions = {}): UseAgentEventsReturn {
  const { agentCount = 3, eventsPerSecond = 2, autoStart = true } = options;
  const store = useMemo(() => new MockAgentStore(agentCount, eventsPerSecond), [agentCount, eventsPerSecond]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => {
    if (autoStart) store.connect();
    return store.disconnect;
  }, [store, autoStart]);
  return { ...snapshot, connect: store.connect, disconnect: store.disconnect, setPaused: store.setPaused };
}

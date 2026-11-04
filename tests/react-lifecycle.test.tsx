import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import type { AgentIdentity, AgentTask, DataProviderEvent } from '@web3viz/core';
import { MockProvider } from '../packages/providers/src/mock/MockProvider';
import { useProviders, type UseProvidersReturn } from '../packages/providers/src/useProviders';
import { MockAgentStore, useAgentEventsMock } from '../hooks/useAgentEventsMock';
import type { UseAgentEventsReturn } from '../hooks/useAgentEvents';
import { TaskInspectorPanel } from '../features/Agents/TaskInspector';

// React's act contract requires an explicit test environment.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class OfflineProvider extends MockProvider {
  starts = 0;
  stops = 0;
  listeners = new Set<(event: DataProviderEvent) => void>();
  override connect() {
    this.starts++;
    for (const listener of this.listeners) listener({
      id: `synthetic-${this.starts}`, providerId: this.id, category: this.categories[0].id,
      chain: 'solana', timestamp: this.starts, label: 'Offline fixture', address: 'synthetic',
    });
  }
  override disconnect() { this.stops++; }
  override onEvent(listener: (event: DataProviderEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

test('provider subscription captures synchronous connect and disposes replaced, disabled and removed instances', async () => {
  const first = new OfflineProvider();
  const second = new OfflineProvider();
  let current: UseProvidersReturn;
  function Harness({ providers }: { providers: OfflineProvider[] }) {
    current = useProviders({ providers, initialEnabledProviderIds: ['mock'], startEnabled: false });
    return null;
  }
  let view: ReactTestRenderer;
  await act(async () => { view = create(<Harness providers={[first]} />); });
  try {
    assert.equal(first.starts, 1);
    assert.equal(first.listeners.size, 1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
    assert.equal(current!.allEvents.length, 1, 'first synchronous event must reach React');
    await act(async () => { view.update(<Harness providers={[second]} />); });
    assert.equal(first.stops, 1);
    assert.equal(first.listeners.size, 0);
    assert.equal(second.starts, 1);
    await act(async () => { current!.toggleProvider('mock'); });
    assert.equal(second.stops, 1);
    assert.equal(second.listeners.size, 0);
    await act(async () => { current!.toggleProvider('mock'); });
    assert.equal(second.starts, 2);
    await act(async () => { view.update(<Harness providers={[]} />); });
    assert.equal(second.stops, 2);
    assert.equal(second.listeners.size, 0);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test('demo starts when enabled after mount, stops on disable, and can reconnect', async () => {
  let current: UseAgentEventsReturn;
  function Harness({ enabled }: { enabled: boolean }) {
    current = useAgentEventsMock({ autoStart: enabled, agentCount: 2 });
    return null;
  }
  let view: ReactTestRenderer;
  await act(async () => { view = create(<Harness enabled={false} />); });
  try {
    assert.equal(current!.connected, false);
    await act(async () => { view.update(<Harness enabled />); });
    assert.equal(current!.connected, true);
    assert.equal(current!.agents.size, 2);
    await act(async () => { view.update(<Harness enabled={false} />); });
    assert.equal(current!.agents.size, 0);
    assert.equal(current!.recentEvents.length, 0);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    assert.equal(current!.recentEvents.length, 0, 'delayed spawn must not return after disconnect');
    await act(async () => { current!.connect(); });
    assert.equal(current!.connected, true);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test('offline snapshots stay immutable, preserve paused completions, and cancel every delayed event on disconnect', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10_000 });
  t.mock.method(Math, 'random', () => 0.2);
  const store = new MockAgentStore(1, 2);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.connect();
  const initial = store.getSnapshot();
  t.mock.timers.tick(1000);
  assert.equal(initial.recentEvents.length, 0);
  assert.equal(initial.flows.get('agent_000')!.tasks.length, 0);
  assert.equal(store.getSnapshot().stats.totalToolCalls, 1);
  store.setPaused(true);
  t.mock.timers.tick(400);
  assert.equal(store.getSnapshot().flows.get('agent_000')!.toolCalls[0].status, 'started');
  store.setPaused(false);
  assert.equal(store.getSnapshot().flows.get('agent_000')!.toolCalls[0].status, 'completed');
  store.disconnect();
  const stopped = store.getSnapshot();
  const count = notifications;
  t.mock.timers.tick(60_000);
  assert.equal(notifications, count);
  assert.equal(store.getSnapshot(), stopped);
  assert.equal(stopped.agents.size, 0);
  assert.equal(stopped.recentEvents.length, 0);
  assert.equal(stopped.stats.totalToolCalls, 0);
  unsubscribe();
});

test('task inspector keeps hook order when selection appears, changes and clears', async () => {
  const agent: AgentIdentity = { agentId: 'fixture', name: 'Offline', role: 'fixture', createdAt: 1 };
  const task: AgentTask = { taskId: 'fixture', agentId: agent.agentId, description: 'Synthetic task', status: 'completed', createdAt: 1, startedAt: 1000, endedAt: 3000 };
  const common = { toolCalls: [], subAgents: [], recentEvents: [], onClose: () => {} };
  let view: ReactTestRenderer;
  await act(async () => { view = create(<TaskInspectorPanel {...common} task={null} agent={null} />); });
  try {
    assert.equal(view!.toJSON(), null);
    await act(async () => { view.update(<TaskInspectorPanel {...common} task={task} agent={agent} />); });
    assert.match(JSON.stringify(view!.toJSON()), /2s/);
    await act(async () => { view.update(<TaskInspectorPanel {...common} task={null} agent={null} />); });
    assert.equal(view!.toJSON(), null);
    await act(async () => { view.update(<TaskInspectorPanel {...common} task={{ ...task, taskId: 'second' }} agent={agent} />); });
    assert.match(JSON.stringify(view!.toJSON()), /Synthetic task/);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

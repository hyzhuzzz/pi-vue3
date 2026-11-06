import { describe, expect, it } from 'vitest';
import type { AssistantEvent, TaskSnapshot } from '@pi-vue3/protocol';
import { applyTaskSnapshot, reduceAssistantEvent } from './reducer';

const initial: TaskSnapshot = {
  sessionId: 'session-a', taskId: 'task-a', traceId: 'trace-a', status: 'running', seq: 3,
  messages: [{ id: 'old', taskId: 'task-a', role: 'assistant', text: 'old', status: 'streaming', createdAt: '2026-11-06T00:00:00Z' }],
  tools: [],
};

function statusEvent(sessionId: string, taskId: string, seq: number, status: 'failed' | 'completed' = 'failed'): AssistantEvent {
  return { type: 'task.status', sessionId, taskId, traceId: 'trace-a', seq, occurredAt: '2026-11-06T00:00:01Z', payload: { status } };
}

describe('assistant event reducer', () => {
  it('ignores duplicate sequence numbers', () => {
    const result = reduceAssistantEvent(initial, statusEvent('session-a', 'task-a', 3));
    expect(result.accepted).toBe(false);
    expect(result.snapshot).toBe(initial);
  });

  it('asks for a snapshot when a sequence gap appears', () => {
    const result = reduceAssistantEvent(initial, statusEvent('session-a', 'task-a', 5));
    expect(result.needsResync).toBe(true);
    expect(result.snapshot).toBe(initial);
  });

  it('replaces all task state from an authoritative snapshot', () => {
    const next: TaskSnapshot = {
      ...initial, seq: 8, status: 'completed',
      messages: [{ id: 'fresh', taskId: 'task-a', role: 'assistant', text: 'restored', status: 'completed', createdAt: '2026-11-06T00:01:00Z' }],
      tools: [{ id: 'tool', taskId: 'task-a', name: 'get_demo_items', arguments: {}, result: [], status: 'completed', createdAt: '2026-11-06T00:01:00Z' }],
    };

    const replaced = applyTaskSnapshot(initial, next);
    expect(replaced).toEqual(next);
    expect(replaced.messages.map((message) => message.id)).toEqual(['fresh']);
  });

  it('gates events from an inactive session or task', () => {
    const wrongSession = reduceAssistantEvent(initial, statusEvent('session-b', 'task-a', 4), { sessionId: 'session-a', taskId: 'task-a' });
    const wrongTask = reduceAssistantEvent(initial, statusEvent('session-a', 'task-b', 4), { sessionId: 'session-a', taskId: 'task-a' });
    expect(wrongSession.accepted).toBe(false);
    expect(wrongTask.accepted).toBe(false);
    expect(wrongSession.snapshot).toBe(initial);
    expect(wrongTask.snapshot).toBe(initial);
  });
});

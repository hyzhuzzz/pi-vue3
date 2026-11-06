import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@pi-vue3/protocol';
import { resolveInitialSessionLoad } from './session-state';

const createdSession: SessionSummary = {
  sessionId: 'created-during-startup', title: '新对话', createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z', messageCount: 1,
};

describe('initial session load reconciliation', () => {
  it('keeps a lazily-created session when the empty startup response arrives late', () => {
    const result = resolveInitialSessionLoad({
      startedAtVersion: 0,
      currentVersion: 1,
      currentSessions: [createdSession],
      currentSelectedSessionId: createdSession.sessionId,
      loadedSessions: [],
      persistedSessionId: null,
    });

    expect(result.applied).toBe(false);
    expect(result.sessions).toEqual([createdSession]);
    expect(result.selectedSessionId).toBe(createdSession.sessionId);
    expect(result.sessionToLoad).toBeNull();
  });

  it('restores the persisted selection when no user action superseded initialization', () => {
    const olderSession = { ...createdSession, sessionId: 'older' };
    const result = resolveInitialSessionLoad({
      startedAtVersion: 4,
      currentVersion: 4,
      currentSessions: [],
      currentSelectedSessionId: null,
      loadedSessions: [createdSession, olderSession],
      persistedSessionId: 'older',
    });

    expect(result.applied).toBe(true);
    expect(result.sessions).toEqual([createdSession, olderSession]);
    expect(result.sessionToLoad).toBe('older');
  });
});

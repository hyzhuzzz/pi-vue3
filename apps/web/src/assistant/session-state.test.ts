import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@pi-vue3/protocol';
import {
  isSubmissionTargetCurrent,
  mergeSessionSummaries,
  resolveInitialSessionLoad,
  shouldPublishAcceptedSubmission,
} from './session-state';

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

  it('reconciles startup sessions after lazy creation fails without changing the active selection', () => {
    const existing = { ...createdSession, sessionId: 'existing-session', title: '已有会话' };
    const result = resolveInitialSessionLoad({
      startedAtVersion: 2,
      currentVersion: 3,
      currentSessions: [],
      currentSelectedSessionId: null,
      loadedSessions: [existing],
      persistedSessionId: 'existing-session',
    });

    expect(result.applied).toBe(false);
    expect(result.sessions).toEqual([existing]);
    expect(result.selectedSessionId).toBeNull();
    expect(result.sessionToLoad).toBeNull();
  });

  it('merges late list data without replacing a session selected during initialization', () => {
    const previouslyLoaded = { ...createdSession, sessionId: 'previously-loaded', title: '已选择' };
    const lateSession = { ...createdSession, sessionId: 'late-session', title: '启动时已存在' };
    const result = resolveInitialSessionLoad({
      startedAtVersion: 0,
      currentVersion: 1,
      currentSessions: [previouslyLoaded],
      currentSelectedSessionId: previouslyLoaded.sessionId,
      loadedSessions: [lateSession],
      persistedSessionId: lateSession.sessionId,
    });

    expect(result.sessions).toEqual([previouslyLoaded, lateSession]);
    expect(result.selectedSessionId).toBe(previouslyLoaded.sessionId);
    expect(result.sessionToLoad).toBeNull();
  });

  it('does not restore a session deleted while the startup request was in flight', () => {
    const deleted = { ...createdSession, sessionId: 'deleted-session' };
    const result = resolveInitialSessionLoad({
      startedAtVersion: 0,
      currentVersion: 1,
      currentSessions: [],
      currentSelectedSessionId: null,
      loadedSessions: [deleted],
      persistedSessionId: deleted.sessionId,
      excludedSessionIds: [deleted.sessionId],
    });

    expect(result.sessions).toEqual([]);
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

  it('does not post a lazy submission after session navigation supersedes its target', () => {
    const current = isSubmissionTargetCurrent(
      { sessionId: createdSession.sessionId, selectionVersion: 4 },
      'existing-session',
      'existing-session',
      5,
    );

    expect(current).toBe(false);
    expect(isSubmissionTargetCurrent(
      { sessionId: createdSession.sessionId, selectionVersion: 4 },
      createdSession.sessionId,
      createdSession.sessionId,
      4,
    )).toBe(true);
  });

  it('keeps an accepted task in the background when another session is now selected', () => {
    expect(shouldPublishAcceptedSubmission('session-old', 'session-new', 'session-new')).toBe(false);
    expect(shouldPublishAcceptedSubmission('session-old', 'session-old', 'session-old')).toBe(true);
  });

  it('keeps freshly listed sessions discoverable when the API list omits a current entry', () => {
    const listed = { ...createdSession, sessionId: 'listed' };
    const current = { ...createdSession, sessionId: 'created-while-listing' };

    expect(mergeSessionSummaries([listed], [current])).toEqual([listed, current]);
  });
});

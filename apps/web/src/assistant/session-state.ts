import type { SessionSummary } from '@pi-vue3/protocol';

export interface InitialSessionLoadInput {
  startedAtVersion: number;
  currentVersion: number;
  currentSessions: SessionSummary[];
  currentSelectedSessionId: string | null;
  loadedSessions: SessionSummary[];
  persistedSessionId: string | null;
}

export interface InitialSessionLoadResult {
  applied: boolean;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  sessionToLoad: string | null;
}

/** Prevent a late startup list response from overwriting session choices made while it was in flight. */
export function resolveInitialSessionLoad(input: InitialSessionLoadInput): InitialSessionLoadResult {
  if (input.startedAtVersion !== input.currentVersion) {
    return {
      applied: false,
      sessions: input.currentSessions,
      selectedSessionId: input.currentSelectedSessionId,
      sessionToLoad: null,
    };
  }

  const selected = input.loadedSessions.find((session) => session.sessionId === input.persistedSessionId)
    ?? input.loadedSessions[0];
  const selectedSessionId = selected?.sessionId ?? null;
  return {
    applied: true,
    sessions: input.loadedSessions,
    selectedSessionId,
    sessionToLoad: selectedSessionId,
  };
}

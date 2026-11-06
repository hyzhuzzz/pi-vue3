import type { SessionSummary } from '@pi-vue3/protocol';

export interface InitialSessionLoadInput {
  startedAtVersion: number;
  currentVersion: number;
  currentSessions: SessionSummary[];
  currentSelectedSessionId: string | null;
  loadedSessions: SessionSummary[];
  persistedSessionId: string | null;
  excludedSessionIds?: string[];
}

export interface InitialSessionLoadResult {
  applied: boolean;
  sessions: SessionSummary[];
  selectedSessionId: string | null;
  sessionToLoad: string | null;
}

export interface SubmissionSelectionTarget {
  sessionId: string;
  selectionVersion: number;
}

export function mergeSessionSummaries(primary: SessionSummary[], secondary: SessionSummary[]): SessionSummary[] {
  const seen = new Set(primary.map((session) => session.sessionId));
  return [...primary, ...secondary.filter((session) => !seen.has(session.sessionId))];
}

export function isSubmissionTargetCurrent(
  target: SubmissionSelectionTarget,
  selectedSessionId: string | null,
  currentSessionId: string | null,
  selectionVersion: number,
): boolean {
  return target.sessionId === selectedSessionId
    && target.sessionId === currentSessionId
    && target.selectionVersion === selectionVersion;
}

export function shouldPublishAcceptedSubmission(
  taskSessionId: string,
  selectedSessionId: string | null,
  currentSessionId: string | null,
): boolean {
  return taskSessionId === selectedSessionId && taskSessionId === currentSessionId;
}

/** Prevent a late startup list response from overwriting session choices made while it was in flight. */
export function resolveInitialSessionLoad(input: InitialSessionLoadInput): InitialSessionLoadResult {
  if (input.startedAtVersion !== input.currentVersion) {
    return {
      applied: false,
      sessions: mergeSessionSummaries(
        input.currentSessions,
        input.loadedSessions.filter((session) => !input.excludedSessionIds?.includes(session.sessionId)),
      ),
      selectedSessionId: input.currentSelectedSessionId,
      sessionToLoad: null,
    };
  }

  const loadedSessions = input.loadedSessions.filter((session) => !input.excludedSessionIds?.includes(session.sessionId));
  const selected = loadedSessions.find((session) => session.sessionId === input.persistedSessionId)
    ?? loadedSessions[0];
  const selectedSessionId = selected?.sessionId ?? null;
  return {
    applied: true,
    sessions: loadedSessions,
    selectedSessionId,
    sessionToLoad: selectedSessionId,
  };
}

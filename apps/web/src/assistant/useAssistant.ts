import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import {
  isTerminalTaskStatus,
  type AssistantEvent,
  type AssistantStreamEvent,
  type CreateTaskRequest,
  type HealthResponse,
  type JsonObject,
  type SessionDetail,
  type SessionSummary,
  type TaskSnapshot,
} from '@pi-vue3/protocol';
import { AssistantApi } from './api';
import { applyTaskSnapshot, reduceAssistantEvent } from './reducer';

const SESSION_STORAGE_KEY = 'pi-vue3.assistant.session';
const MAX_RECONNECTS = 3;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : '发生了意外错误，请稍后重试。';
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isAssistantEvent(event: AssistantStreamEvent): event is AssistantEvent {
  return event.type === 'task.status'
    || event.type === 'message.upserted'
    || event.type === 'message.delta'
    || event.type === 'tool.upserted';
}

export function useAssistant(baseUrl: string, getPageContext: () => JsonObject | undefined) {
  const api = new AssistantApi(baseUrl);
  const health = ref<HealthResponse | null>(null);
  const sessions = ref<SessionSummary[]>([]);
  const selectedSessionId = ref<string | null>(null);
  const currentSession = shallowRef<SessionDetail | null>(null);
  const currentTask = shallowRef<TaskSnapshot | null>(null);
  const initializing = ref(true);
  const loadingSession = ref(false);
  const submitting = ref(false);
  const draft = ref('');
  const retryText = ref('');
  const error = ref<string | null>(null);
  let selectionVersion = 0;
  let taskController: AbortController | null = null;
  let disposed = false;

  const taskIsActive = computed(() => currentTask.value !== null
    && !isTerminalTaskStatus(currentTask.value.status));

  function saveSelection(sessionId: string | null): void {
    try {
      if (sessionId) window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
      else window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Session history still works when the browser blocks local storage.
    }
  }

  function updateSessionSummary(detail: SessionDetail): void {
    const summary: SessionSummary = {
      sessionId: detail.sessionId,
      title: detail.title,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      messageCount: detail.messageCount,
    };
    const index = sessions.value.findIndex((item) => item.sessionId === detail.sessionId);
    if (index < 0) sessions.value = [summary, ...sessions.value];
    else sessions.value = sessions.value.map((item) => item.sessionId === detail.sessionId ? summary : item);
  }

  function publishSnapshot(snapshot: TaskSnapshot): void {
    currentTask.value = snapshot;
    const detail = currentSession.value;
    if (!detail || detail.sessionId !== snapshot.sessionId) return;
    const next: SessionDetail = {
      ...detail,
      messages: snapshot.messages,
      tools: snapshot.tools,
    };
    if (isTerminalTaskStatus(snapshot.status)) delete next.activeTaskId;
    else next.activeTaskId = snapshot.taskId;
    currentSession.value = next;
  }

  async function refreshCurrentHistory(sessionId: string, taskId: string): Promise<void> {
    try {
      const [detail, list] = await Promise.all([api.getSession(sessionId), api.listSessions()]);
      if (disposed || selectedSessionId.value !== sessionId || currentTask.value?.taskId !== taskId) return;
      currentSession.value = detail;
      sessions.value = list;
    } catch {
      // The streamed result remains visible; history will be reconciled on the next session load.
    }
  }

  function startTaskSubscription(initialSnapshot: TaskSnapshot): void {
    taskController?.abort();
    const controller = new AbortController();
    taskController = controller;
    const { sessionId, taskId } = initialSnapshot;
    let latest = initialSnapshot;
    let lastFailure: string | null = null;
    const isCurrent = () => !disposed
      && !controller.signal.aborted
      && selectedSessionId.value === sessionId
      && currentTask.value?.taskId === taskId;

    const reconcile = async (): Promise<boolean> => {
      const authoritative = await api.getTask(taskId, controller.signal);
      if (!isCurrent()) return false;
      latest = applyTaskSnapshot(latest, authoritative);
      publishSnapshot(latest);
      return true;
    };

    void (async () => {
      for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt += 1) {
        if (!isCurrent()) return;
        if (isTerminalTaskStatus(latest.status)) {
          await refreshCurrentHistory(sessionId, taskId);
          return;
        }
        if (attempt > 0) {
          try {
            if (!await reconcile()) return;
          } catch (reconnectError) {
            if (controller.signal.aborted) return;
            lastFailure = messageFromError(reconnectError);
          }
          if (isTerminalTaskStatus(latest.status)) {
            await refreshCurrentHistory(sessionId, taskId);
            return;
          }
        }

        try {
          for await (const event of api.taskEvents(taskId, latest.seq, controller.signal)) {
            if (!isCurrent()) return;
            if (event.sessionId !== sessionId || event.taskId !== taskId) continue;

            if (event.type === 'resync_required') {
              if (await reconcile()) break;
              return;
            }
            if (!isAssistantEvent(event)) continue;

            const reduction = reduceAssistantEvent(latest, event, { sessionId, taskId });
            if (reduction.needsResync) {
              if (await reconcile()) break;
              return;
            }
            if (!reduction.accepted) continue;
            latest = reduction.snapshot;
            publishSnapshot(latest);
            if (isTerminalTaskStatus(latest.status)) {
              await refreshCurrentHistory(sessionId, taskId);
              return;
            }
          }
        } catch (streamError) {
          if (controller.signal.aborted) return;
          lastFailure = messageFromError(streamError);
        }

        if (!isCurrent()) return;
        if (isTerminalTaskStatus(latest.status)) {
          await refreshCurrentHistory(sessionId, taskId);
          return;
        }
        if (attempt === MAX_RECONNECTS) {
          error.value = lastFailure
            ? `${lastFailure} 助手任务仍可能在后台运行，切换回会话可恢复进度。`
            : '连接暂时中断。助手任务仍可能在后台运行，切换回会话可恢复进度。';
        }
      }
    })();
  }

  async function selectSession(sessionId: string): Promise<void> {
    taskController?.abort();
    taskController = null;
    const version = ++selectionVersion;
    selectedSessionId.value = sessionId;
    currentSession.value = null;
    currentTask.value = null;
    loadingSession.value = true;
    error.value = null;
    saveSelection(sessionId);
    try {
      const detail = await api.getSession(sessionId);
      if (disposed || version !== selectionVersion) return;
      currentSession.value = detail;
      updateSessionSummary(detail);
      if (detail.activeTaskId) {
        const snapshot = await api.getTask(detail.activeTaskId);
        if (disposed || version !== selectionVersion) return;
        publishSnapshot(snapshot);
        if (!isTerminalTaskStatus(snapshot.status)) startTaskSubscription(snapshot);
      }
    } catch (loadError) {
      if (!disposed && version === selectionVersion) error.value = messageFromError(loadError);
    } finally {
      if (version === selectionVersion) loadingSession.value = false;
    }
  }

  async function initialize(): Promise<void> {
    initializing.value = true;
    try {
      const [healthResult, sessionList] = await Promise.all([api.health(), api.listSessions()]);
      health.value = healthResult;
      sessions.value = sessionList;
      let persistedSelection: string | null = null;
      try {
        persistedSelection = window.localStorage.getItem(SESSION_STORAGE_KEY);
      } catch {
        persistedSelection = null;
      }
      const selected = sessionList.find((item) => item.sessionId === persistedSelection)
        ?? sessionList[0];
      if (selected) await selectSession(selected.sessionId);
      else {
        selectedSessionId.value = null;
        currentSession.value = null;
        currentTask.value = null;
        saveSelection(null);
      }
    } catch (loadError) {
      error.value = messageFromError(loadError);
    } finally {
      initializing.value = false;
    }
  }

  async function createSession(): Promise<SessionDetail> {
    taskController?.abort();
    taskController = null;
    const detail = await api.createSession();
    const list = await api.listSessions();
    sessions.value = list;
    selectedSessionId.value = detail.sessionId;
    currentSession.value = detail;
    currentTask.value = null;
    saveSelection(detail.sessionId);
    updateSessionSummary(detail);
    error.value = null;
    return detail;
  }

  async function renameSession(sessionId: string, title: string): Promise<void> {
    const detail = await api.renameSession(sessionId, title.trim());
    updateSessionSummary(detail);
    if (selectedSessionId.value === sessionId) currentSession.value = detail;
  }

  async function deleteSession(sessionId: string): Promise<void> {
    await api.deleteSession(sessionId);
    const list = await api.listSessions();
    sessions.value = list;
    if (selectedSessionId.value === sessionId) {
      taskController?.abort();
      taskController = null;
      currentTask.value = null;
      currentSession.value = null;
      selectedSessionId.value = null;
      saveSelection(null);
      const next = list[0];
      if (next) await selectSession(next.sessionId);
    }
  }

  async function send(text = draft.value): Promise<void> {
    const normalizedText = text.trim();
    if (!normalizedText || submitting.value || taskIsActive.value) return;
    submitting.value = true;
    error.value = null;
    retryText.value = '';
    try {
      let detail = currentSession.value;
      if (!detail) detail = await createSession();
      const request: CreateTaskRequest = {
        text: normalizedText,
        clientRequestId: newRequestId(),
      };
      const context = getPageContext();
      if (context) Reflect.set(request, 'context', context);
      const snapshot = await api.createTask(detail.sessionId, request);
      draft.value = '';
      retryText.value = normalizedText;
      publishSnapshot(snapshot);
      startTaskSubscription(snapshot);
    } catch (sendError) {
      error.value = messageFromError(sendError);
      retryText.value = normalizedText;
    } finally {
      submitting.value = false;
    }
  }

  async function stop(): Promise<void> {
    const snapshot = currentTask.value;
    if (!snapshot || !taskIsActive.value) return;
    error.value = null;
    try {
      const cancelled = await api.cancelTask(snapshot.taskId);
      if (selectedSessionId.value !== snapshot.sessionId || currentTask.value?.taskId !== snapshot.taskId) return;
      const next = applyTaskSnapshot(currentTask.value, cancelled);
      publishSnapshot(next);
      if (isTerminalTaskStatus(next.status)) void refreshCurrentHistory(snapshot.sessionId, snapshot.taskId);
    } catch (stopError) {
      error.value = messageFromError(stopError);
    }
  }

  onBeforeUnmount(() => {
    disposed = true;
    taskController?.abort();
    taskController = null;
  });

  return {
    health,
    sessions,
    selectedSessionId,
    currentSession,
    currentTask,
    initializing,
    loadingSession,
    submitting,
    taskIsActive,
    draft,
    retryText,
    error,
    initialize,
    selectSession,
    createSession,
    renameSession,
    deleteSession,
    send,
    stop,
  };
}

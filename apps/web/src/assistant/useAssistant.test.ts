import { createRenderer, defineComponent } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail, SessionSummary, TaskSnapshot } from '@pi-vue3/protocol';
import { useAssistant } from './useAssistant';

interface HostNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  parent: HostNode | null;
  children: HostNode[];
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(element, key, _previous, next) { element.props[key] = next; },
  insert(child, parent, anchor) {
    if (child.parent) {
      const oldIndex = child.parent.children.indexOf(child);
      if (oldIndex >= 0) child.parent.children.splice(oldIndex, 1);
    }
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
  },
  remove(child) {
    if (child.parent) {
      const index = child.parent.children.indexOf(child);
      if (index >= 0) child.parent.children.splice(index, 1);
    }
    child.parent = null;
  },
  createElement(type) { return { type, text: '', props: {}, parent: null, children: [] }; },
  createText(text) { return { type: '#text', text, props: {}, parent: null, children: [] }; },
  createComment(text) { return { type: '#comment', text, props: {}, parent: null, children: [] }; },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; node.children = []; },
  parentNode(node) { return node.parent; },
  nextSibling(node) {
    if (!node.parent) return null;
    return node.parent.children[node.parent.children.indexOf(node) + 1] ?? null;
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function summary(sessionId: string, title: string): SessionSummary {
  return {
    sessionId, title, createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z', messageCount: 0,
  };
}

function detail(sessionId: string, title: string): SessionDetail {
  return { ...summary(sessionId, title), messages: [], tools: [] };
}

function taskSnapshot(sessionId: string): TaskSnapshot {
  return {
    sessionId, taskId: 'task-old', traceId: 'trace-old', status: 'running', seq: 1,
    messages: [{ id: 'user-old', taskId: 'task-old', role: 'user', text: '保留这条提问', status: 'completed', createdAt: '2026-11-06T00:00:01.000Z' }],
    tools: [],
  };
}

function mountAssistant() {
  let assistant!: ReturnType<typeof useAssistant>;
  const App = defineComponent({
    setup() {
      assistant = useAssistant('/api/assistant', () => undefined);
      return () => null;
    },
  });
  const app = renderer.createApp(App);
  app.mount({ type: 'root', text: '', props: {}, parent: null, children: [] });
  return { assistant, unmount: () => app.unmount() };
}

afterEach(() => vi.unstubAllGlobals());

describe('useAssistant submission session ownership', () => {
  it('does not post or clear the draft when navigation supersedes lazy session creation', async () => {
    const initialList = deferred<Response>();
    const createdSessionResponse = deferred<Response>();
    const createStarted = deferred<void>();
    let listCalls = 0;
    let taskPosts = 0;
    const other = detail('other', '已有会话');
    const created = detail('created', '新对话');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/health')) return json({ status: 'ok', configured: true });
      if (url.pathname.endsWith('/sessions') && method === 'GET') {
        listCalls += 1;
        if (listCalls === 1) return initialList.promise;
        return json([summary('other', '已有会话'), summary('created', '新对话')]);
      }
      if (url.pathname.endsWith('/sessions') && method === 'POST') {
        createStarted.resolve();
        return createdSessionResponse.promise;
      }
      if (url.pathname.endsWith('/sessions/other')) return json(other);
      if (url.pathname.endsWith('/tasks') && method === 'POST') {
        taskPosts += 1;
        return json(taskSnapshot('created'), 202);
      }
      return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    }));

    const mounted = mountAssistant();
    const initialization = mounted.assistant.initialize();
    mounted.assistant.draft.value = '请发送到我刚开始的新会话';
    const submission = mounted.assistant.send();
    await createStarted.promise;

    await mounted.assistant.selectSession('other');
    createdSessionResponse.resolve(json(created, 201));
    await submission;
    initialList.resolve(json([summary('other', '已有会话')]));
    await initialization;

    expect(taskPosts).toBe(0);
    expect(mounted.assistant.draft.value).toBe('请发送到我刚开始的新会话');
    expect(mounted.assistant.selectedSessionId.value).toBe('other');
    expect(mounted.assistant.currentSession.value?.sessionId).toBe('other');
    expect(mounted.assistant.sessions.value.map((session) => session.sessionId)).toEqual(['other', 'created']);
    mounted.unmount();
  });

  it('keeps an accepted task discoverable without painting it into the session selected afterward', async () => {
    const taskResponse = deferred<Response>();
    const taskStarted = deferred<void>();
    const backgroundHistoryLoaded = deferred<void>();
    let taskAccepted = false;
    const oldSession = detail('old', '原会话');
    const newSession = detail('new', '新会话');
    const sessions = [summary('old', '原会话'), summary('new', '新会话')];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      if (url.pathname.endsWith('/health')) return json({ status: 'ok', configured: true });
      if (url.pathname.endsWith('/sessions') && method === 'GET') return json(sessions);
      if (url.pathname.endsWith('/sessions/old') && method === 'GET') {
        if (taskAccepted) {
          backgroundHistoryLoaded.resolve();
          return json({ ...oldSession, messages: [{ id: 'user-old', taskId: 'task-old', role: 'user', text: '保留这条提问', status: 'completed', createdAt: '2026-11-06T00:00:01.000Z' }], activeTaskId: 'task-old' });
        }
        return json(oldSession);
      }
      if (url.pathname.endsWith('/sessions/new') && method === 'GET') return json(newSession);
      if (url.pathname.endsWith('/sessions/old/tasks') && method === 'POST') {
        taskStarted.resolve();
        return taskResponse.promise;
      }
      if (url.pathname.endsWith('/tasks/task-old')) return json(taskSnapshot('old'));
      if (url.pathname.endsWith('/tasks/task-old/events')) {
        return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
    }));

    const mounted = mountAssistant();
    await mounted.assistant.initialize();
    mounted.assistant.draft.value = '发送后切换页面';
    const submission = mounted.assistant.send();
    await taskStarted.promise;
    await mounted.assistant.selectSession('new');
    taskAccepted = true;
    taskResponse.resolve(json(taskSnapshot('old'), 202));
    await submission;
    await backgroundHistoryLoaded.promise;
    await Promise.resolve();

    expect(mounted.assistant.currentSession.value?.sessionId).toBe('new');
    expect(mounted.assistant.currentSession.value?.messages).toEqual([]);
    expect(mounted.assistant.currentTask.value).toBeNull();
    expect(mounted.assistant.draft.value).toBe('发送后切换页面');
    expect(mounted.assistant.sessions.value.map((session) => session.sessionId)).toContain('old');
    mounted.unmount();
  });
});

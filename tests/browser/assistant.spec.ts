import { test, expect, type Page } from '@playwright/test';

const now = '2026-11-06T02:00:00.000Z';

/** Deterministic transport fixture: exercises the actual Vue UI without an external model. */
async function mockAssistant(page: Page) {
  const session = {
    sessionId: 'session-browser', title: '浏览器测试', createdAt: now, updatedAt: now,
    messageCount: 0, messages: [] as Record<string, unknown>[], tools: [] as Record<string, unknown>[],
  };
  let created = false;
  let snapshot: Record<string, unknown> | undefined;
  await page.route('**/api/assistant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/assistant', '');
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/health') return json({ status: 'ok', configured: true, model: 'browser-fixture' });
    if (path === '/sessions' && method === 'GET') return json(created ? [session] : []);
    if (path === '/sessions' && method === 'POST') { created = true; return json(session, 201); }
    if (path === '/sessions/session-browser' && method === 'GET') return json(session);
    if (path === '/sessions/session-browser' && method === 'PATCH') {
      session.title = request.postDataJSON().title;
      return json(session);
    }
    if (path === '/sessions/session-browser' && method === 'DELETE') {
      created = false;
      return route.fulfill({ status: 204 });
    }
    if (path === '/sessions/session-browser/tasks' && method === 'POST') {
      const { text } = request.postDataJSON();
      const user = { id: 'user-1', taskId: 'task-browser', role: 'user', text, status: 'completed', createdAt: now };
      session.messages = [user];
      session.messageCount = 1;
      snapshot = { sessionId: session.sessionId, taskId: 'task-browser', traceId: 'trace-browser',
        status: 'running', seq: 1, messages: [user], tools: [] };
      return json(snapshot, 202);
    }
    if (path === '/tasks/task-browser') return json(snapshot);
    if (path === '/tasks/task-browser/events') {
      const assistant = { id: 'assistant-1', taskId: 'task-browser', role: 'assistant', text: '', status: 'streaming', createdAt: now };
      const tool = { id: 'tool-1', taskId: 'task-browser', name: 'get_demo_items', arguments: { query: 'framework' },
        result: { items: ['示例能力'] }, status: 'completed', createdAt: now, startedAt: now, completedAt: now };
      const finalMessage = { ...assistant, text: '基础能力已接入。\n\n<img src=x onerror="window.__assistantXss=1">', status: 'completed' };
      const event = (seq: number, type: string, payload: unknown) => ({
        type, sessionId: session.sessionId, taskId: 'task-browser', traceId: 'trace-browser', seq, occurredAt: now, payload,
      });
      const delta = event(3, 'message.delta', { messageId: assistant.id, delta: '基础能力已接入。' });
      const events = [event(2, 'message.upserted', { message: assistant }), delta, delta,
        event(4, 'tool.upserted', { tool }), event(5, 'message.upserted', { message: finalMessage }),
        event(6, 'task.status', { status: 'completed' })];
      session.messages = [...session.messages.filter(m => m.role === 'user'), finalMessage];
      session.tools = [tool];
      session.messageCount = 2;
      snapshot = { ...snapshot, status: 'completed', seq: 6, messages: session.messages, tools: session.tools };
      const after = Number(url.searchParams.get('after') || 0);
      return route.fulfill({ status: 200, contentType: 'text/event-stream',
        body: events.filter(e => e.seq > after).map(e => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join('') });
    }
    return json({ error: { code: 'NOT_FOUND', message: '测试端点不存在' } }, 404);
  });
}

test('global launcher, streamed tool result, history and safe Markdown', async ({ page }) => {
  await mockAssistant(page);
  await page.goto('/');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.getByRole('textbox', { name: '消息输入框' }).fill('检查基础能力');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('基础能力已接入。', { exact: true })).toBeVisible();
  await expect(page.getByText('get_demo_items', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__assistantXss)).toBeUndefined();
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await expect(page.getByRole('button', { name: '还原助手', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起助手', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByText('基础能力已接入。', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByText('基础能力已接入。', { exact: true })).toBeVisible();
});

test('narrow viewport supports session creation, rename and delete', async ({ page }) => {
  await mockAssistant(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息输入框' })).toBeVisible();
  await page.locator('.header-new-session').click();
  await expect(page.locator('.conversation-topline h3')).toHaveText('浏览器测试');
  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await page.getByRole('button', { name: '重命名会话 浏览器测试', exact: true }).click();
  await page.getByPlaceholder('会话名称').fill('手机端会话');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.conversation-topline h3')).toHaveText('手机端会话');
  await page.getByRole('button', { name: '删除会话 手机端会话', exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.conversation-topline h3')).toHaveText('新对话');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

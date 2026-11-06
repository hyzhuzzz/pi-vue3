import { test, expect, type Page } from '@playwright/test';

const now = '2026-11-06T02:00:00.000Z';

/** Deterministic transport fixture: exercises the actual Vue UI without an external model. */
async function mockAssistant(page: Page, outcome: 'success' | 'failure' = 'success') {
  const session = {
    sessionId: 'session-browser', title: '浏览器测试', createdAt: now, updatedAt: now,
    messageCount: 0, messages: [] as Record<string, unknown>[], tools: [] as Record<string, unknown>[],
  };
  const otherSession = {
    sessionId: 'session-other', title: '另一个会话', createdAt: now, updatedAt: now,
    messageCount: 0, messages: [] as Record<string, unknown>[], tools: [] as Record<string, unknown>[],
  };
  let created = false;
  let snapshot: Record<string, unknown> | undefined;
  let taskNumber = 0;
  let currentTaskId = '';
  let latestUser: Record<string, unknown> | undefined;
  await page.route('**/api/assistant/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/assistant', '');
    const method = request.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/health') return json({ status: 'ok', configured: true, model: 'browser-fixture' });
    if (path === '/sessions' && method === 'GET') return json(created ? [session, otherSession] : []);
    if (path === '/sessions' && method === 'POST') { created = true; return json(session, 201); }
    if (path === '/sessions/session-browser' && method === 'GET') return json(session);
    if (path === '/sessions/session-other' && method === 'GET') return json(otherSession);
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
      taskNumber += 1;
      currentTaskId = `task-browser-${taskNumber}`;
      latestUser = { id: `user-${taskNumber}`, taskId: currentTaskId, role: 'user', text, status: 'completed', createdAt: now };
      session.messages = [...session.messages, latestUser];
      session.messageCount = session.messages.length;
      snapshot = { sessionId: session.sessionId, taskId: currentTaskId, traceId: `trace-browser-${taskNumber}`,
        status: 'running', seq: 1, messages: [latestUser], tools: [] };
      return json(snapshot, 202);
    }
    if (currentTaskId && path === `/tasks/${currentTaskId}`) return json(snapshot);
    if (currentTaskId && path === `/tasks/${currentTaskId}/events`) {
      const event = (seq: number, type: string, payload: unknown) => ({
        type, sessionId: session.sessionId, taskId: currentTaskId, traceId: `trace-browser-${taskNumber}`, seq, occurredAt: now, payload,
      });
      if (outcome === 'failure') {
        const error = { code: 'assistant_runtime_error', message: 'The assistant could not complete this task. Check the server configuration and try again.', traceId: `trace-browser-${taskNumber}` };
        snapshot = { ...snapshot, status: 'failed', seq: 2, error };
        return route.fulfill({ status: 200, contentType: 'text/event-stream',
          body: `id: 2\ndata: ${JSON.stringify(event(2, 'task.status', { status: 'failed', error }))}\n\n` });
      }

      const assistant = { id: `assistant-${taskNumber}`, taskId: currentTaskId, role: 'assistant', text: '', status: 'streaming', createdAt: now };
      const tool = { id: `tool-${taskNumber}`, taskId: currentTaskId, name: 'get_demo_items', arguments: { query: 'framework' },
        result: { items: ['示例能力'] }, status: 'completed', createdAt: now, startedAt: now, completedAt: now };
      const finalMessage = { ...assistant, text: '基础能力已接入。\n\n<img src=x onerror="window.__assistantXss=1">', status: 'completed' };
      const delta = event(3, 'message.delta', { messageId: assistant.id, delta: '基础能力已接入。' });
      const events = [event(2, 'message.upserted', { message: assistant }), delta, delta,
        event(4, 'tool.upserted', { tool }), event(5, 'message.upserted', { message: finalMessage }),
        event(6, 'task.status', { status: 'completed' })];
      session.messages = [...session.messages, finalMessage];
      session.tools = [...session.tools, tool];
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

test('shows and dismisses the safe task failure when no assistant message was produced', async ({ page }) => {
  await mockAssistant(page, 'failure');
  await page.goto('/');
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const safeFailure = 'The assistant could not complete this task. Check the server configuration and try again.';

  await page.getByRole('textbox', { name: '消息输入框' }).fill('第一次失败');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(safeFailure);
  await expect(page.locator('.message-assistant')).toHaveCount(0);

  await page.getByRole('button', { name: '关闭错误提示' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('textbox', { name: '消息输入框' }).fill('新任务再次失败');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(safeFailure);

  await page.getByRole('button', { name: '展开助手', exact: true }).click();
  await page.getByRole('button', { name: '打开会话 另一个会话', exact: true }).click();
  await expect(page.locator('.conversation-topline h3')).toHaveText('另一个会话');
  await expect(page.getByRole('alert')).toHaveCount(0);
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

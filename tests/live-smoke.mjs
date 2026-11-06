// Opt-in integration check against a running assistant service, using its configured model.
const base = (process.env.ASSISTANT_BASE_URL ?? 'http://127.0.0.1:3001/api/assistant').replace(/\/$/, '');
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Assistant HTTP ${response.status}`);
  return response.json();
}

async function send(sessionId, text) {
  return request(`/sessions/${sessionId}/tasks`, 'POST', { text, clientRequestId: crypto.randomUUID() });
}

async function finish(taskId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const task = await request(`/tasks/${taskId}`);
    if (terminal.has(task.status)) {
      if (task.status !== 'completed') throw new Error(`Task ended ${task.status}`);
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Model task timed out; inspect the test session before retrying.');
}

try {
  const health = await request('/health');
  if (!health.configured) throw new Error('Configure the server model first.');
  const session = await request('/sessions', 'POST', { title: '模型接入自检' });
  const marker = `CHECK-${crypto.randomUUID().slice(0, 8)}`;
  let task = await send(session.sessionId, `请记住标识 ${marker}，只回复确认。`);
  await finish(task.taskId);
  task = await send(session.sessionId, '刚才让你记住的标识是什么？只回答标识。');
  task = await finish(task.taskId);
  if (!task.messages.filter(message => message.role === 'assistant').at(-1)?.text.includes(marker)) {
    throw new Error('Multi-turn context check failed.');
  }
  task = await send(session.sessionId,
    '请实际调用 read_skill 读取 assistant-basics，然后实际调用 get_demo_items 查询 framework，最后简短总结。');
  task = await finish(task.taskId);
  for (const name of ['read_skill', 'get_demo_items']) {
    if (!task.tools.some(tool => tool.name === name && tool.status === 'completed')) {
      throw new Error(`Model did not complete the ${name} check.`);
    }
  }
  console.log(JSON.stringify({ model: health.model, sessionId: session.sessionId,
    checks: ['text', 'multi-turn context', 'skill read', 'tool calling'], passed: true }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live check failed.');
  process.exitCode = 1;
}

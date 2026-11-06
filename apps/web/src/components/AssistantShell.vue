<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElIcon } from 'element-plus';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ArrowUp,
  ChatDotRound,
  Close,
  Connection,
  Delete,
  EditPen,
  FullScreen,
  MagicStick,
  Plus,
  Refresh,
  ScaleToOriginal,
} from '@element-plus/icons-vue';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import type { ChatMessage, JsonObject, SessionDetail, ToolCall } from '@pi-vue3/protocol';
import { useAssistant } from '../assistant/useAssistant';

const props = withDefaults(defineProps<{
  baseUrl?: string;
  pageContext?: JsonObject;
}>(), {
  baseUrl: '/api/assistant',
});
const isOpen = defineModel<boolean>('open', { default: false });
const expanded = ref(false);
const assistant = useAssistant(props.baseUrl, () => props.pageContext);
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

type TimelineItem =
  | { kind: 'message'; id: string; createdAt: string; message: ChatMessage }
  | { kind: 'tool'; id: string; createdAt: string; tool: ToolCall };

const timeline = computed<TimelineItem[]>(() => {
  const session = assistant.currentSession.value;
  if (!session) return [];
  return [
    ...session.messages
      .filter((message) => !(message.role === 'assistant' && message.status === 'completed' && message.text.trim().length === 0))
      .map((message): TimelineItem => ({ kind: 'message', id: message.id, createdAt: message.createdAt, message })),
    ...session.tools.map((tool): TimelineItem => ({ kind: 'tool', id: tool.id, createdAt: tool.createdAt, tool })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
});

const connectionLabel = computed(() => {
  const health = assistant.health.value;
  if (!health) return '连接检查中';
  if (!health.configured) return '模型待配置';
  return health.model ? `已连接 · ${health.model}` : '已连接';
});

const statusLabel = computed(() => {
  const task = assistant.currentTask.value;
  if (!task) return '';
  if (task.status === 'queued') return '等待开始';
  if (task.status === 'running') return '正在生成';
  if (task.status === 'completed') return '已完成';
  if (task.status === 'cancelled') return '已停止';
  if (task.status === 'interrupted') return '已中断';
  return '任务失败';
});

const selectedTitle = computed(() => assistant.currentSession.value?.title ?? '新对话');

function renderMarkdown(source: string): string {
  const html = markdown.render(source || '');
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function prettyJson(value: unknown): string {
  if (value === undefined) return '等待工具返回结果';
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

function toolLabel(tool: ToolCall): string {
  return tool.name === 'get_demo_items' ? '查询示例能力' : '工具调用';
}

function toolStatus(status: ToolCall['status']): string {
  const labels: Record<ToolCall['status'], string> = {
    pending: '等待中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断',
  };
  return labels[status];
}

function messageStatus(status: ChatMessage['status']): string {
  const labels: Record<ChatMessage['status'], string> = {
    streaming: '正在生成', completed: '已完成', failed: '生成失败', cancelled: '已停止', interrupted: '已中断',
  };
  return labels[status];
}

function submit(): void {
  void assistant.send();
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function usePrompt(text: string): void {
  assistant.draft.value = text;
}

async function addSession(): Promise<void> {
  try {
    await assistant.createSession();
  } catch (error) {
    assistant.error.value = error instanceof Error ? error.message : '创建会话失败。';
  }
}

async function renameSession(session: SessionDetail | undefined): Promise<void> {
  if (!session) return;
  try {
    const { value } = await ElMessageBox.prompt('输入新的会话名称。', '重命名会话', {
      inputValue: session.title,
      inputPlaceholder: '会话名称',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (value: string) => value.trim().length > 0 || '名称不能为空',
    });
    await assistant.renameSession(session.sessionId, value);
    ElMessage.success('会话名称已更新');
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      assistant.error.value = error instanceof Error ? error.message : '重命名失败。';
    }
  }
}

async function removeSession(session: SessionDetail | undefined): Promise<void> {
  if (!session) return;
  try {
    await ElMessageBox.confirm(`删除“${session.title}”及其历史消息？`, '删除会话', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
    await assistant.deleteSession(session.sessionId);
    ElMessage.success('会话已删除');
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      assistant.error.value = error instanceof Error ? error.message : '删除会话失败。';
    }
  }
}

onMounted(() => {
  void assistant.initialize();
});
</script>

<template>
  <button class="assistant-launcher" aria-label="打开 AI 助手" @click="isOpen = true">
    <span class="launcher-symbol"><MagicStick /></span>
    <span>Pi 助手</span>
    <span class="launcher-shortcut">↗</span>
  </button>

  <Transition name="assistant-fade">
    <div v-if="isOpen" class="assistant-layer">
      <button class="assistant-backdrop" aria-label="关闭助手面板" @click="isOpen = false"></button>
      <section class="assistant-window" :class="{ expanded }" role="dialog" aria-modal="true" aria-label="Pi 智能助手">
        <aside v-if="expanded" class="session-sidebar">
          <div class="sidebar-topline">
            <div class="sidebar-brand">
              <span class="sidebar-mark"><MagicStick /></span>
              <span>Pi 助手</span>
            </div>
            <button class="icon-button sidebar-new" aria-label="创建新会话" title="创建新会话" @click="addSession"><Plus /></button>
          </div>

          <button class="new-session-button" @click="addSession">
            <el-icon><Plus /></el-icon>
            <span>新建会话</span>
          </button>

          <div class="session-section-title">
            <span>最近会话</span>
            <span>{{ assistant.sessions.value.length }}</span>
          </div>
          <div v-if="assistant.sessions.value.length" class="session-list">
            <div
              v-for="session in assistant.sessions.value"
              :key="session.sessionId"
              class="session-row"
              :class="{ selected: assistant.selectedSessionId.value === session.sessionId }"
            >
              <button
                class="session-select"
                :aria-label="`打开会话 ${session.title}`"
                @click="assistant.selectSession(session.sessionId)"
              >
                <span class="session-select-icon"><ChatDotRound /></span>
                <span class="session-title-wrap">
                  <span class="session-title">{{ session.title }}</span>
                  <span class="session-meta">{{ session.messageCount }} 条消息</span>
                </span>
              </button>
              <div class="session-row-actions">
                <button class="icon-button" :aria-label="`重命名会话 ${session.title}`" title="重命名" @click="renameSession(assistant.currentSession.value?.sessionId === session.sessionId ? assistant.currentSession.value : { ...session, messages: [], tools: [] })"><EditPen /></button>
                <button class="icon-button danger-hover" :aria-label="`删除会话 ${session.title}`" title="删除" @click="removeSession(assistant.currentSession.value?.sessionId === session.sessionId ? assistant.currentSession.value : { ...session, messages: [], tools: [] })"><Delete /></button>
              </div>
            </div>
          </div>
          <div v-else class="session-empty">
            <span class="session-empty-mark"><ChatDotRound /></span>
            <p>还没有会话</p>
            <span>开始一段新对话，它会保存在这里。</span>
          </div>

          <div class="sidebar-footer">
            <div class="service-indicator"><span :class="{ ready: assistant.health.value?.status === 'ok' }"></span><span>{{ connectionLabel }}</span></div>
            <span class="sidebar-footer-note">对话与任务在本地服务中运行</span>
          </div>
        </aside>

        <div class="assistant-main">
          <header class="assistant-header">
            <div class="assistant-heading">
              <div class="assistant-avatar"><MagicStick /></div>
              <div class="assistant-heading-copy">
                <div class="assistant-title-row">
                  <h2>Pi 智能助手</h2>
                  <span class="header-presence"><i></i>全局可用</span>
                </div>
                <span class="assistant-subtitle">{{ selectedTitle }}</span>
              </div>
            </div>
            <div class="assistant-header-actions">
              <span class="header-connection" :title="connectionLabel"><i :class="{ ready: assistant.health.value?.configured }"></i>{{ connectionLabel }}</span>
              <button class="icon-button header-new-session" aria-label="创建新会话" title="创建新会话" @click="addSession"><Plus /></button>
              <button class="icon-button header-expand" :aria-label="expanded ? '还原助手' : '展开助手'" :title="expanded ? '还原助手' : '展开助手'" @click="expanded = !expanded">
                <ScaleToOriginal v-if="expanded" />
                <FullScreen v-else />
              </button>
              <button class="icon-button header-close" aria-label="收起助手" title="收起助手" @click="isOpen = false"><Close /></button>
            </div>
          </header>

          <div v-if="expanded" class="mobile-session-switcher">
            <select
              :value="assistant.selectedSessionId.value ?? ''"
              aria-label="选择会话"
              @change="assistant.selectSession(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>选择一个会话</option>
              <option v-for="session in assistant.sessions.value" :key="session.sessionId" :value="session.sessionId">{{ session.title }}</option>
            </select>
            <button
              v-if="assistant.currentSession.value"
              class="icon-button"
              :aria-label="`重命名会话 ${assistant.currentSession.value.title}`"
              title="重命名当前会话"
              @click="renameSession(assistant.currentSession.value)"
            ><EditPen /></button>
            <button
              v-if="assistant.currentSession.value"
              class="icon-button danger-hover"
              :aria-label="`删除会话 ${assistant.currentSession.value.title}`"
              title="删除当前会话"
              @click="removeSession(assistant.currentSession.value)"
            ><Delete /></button>
            <button class="icon-button" aria-label="创建新会话" @click="addSession"><Plus /></button>
          </div>

          <div v-if="assistant.health.value && !assistant.health.value.configured" class="config-notice" role="status">
            <span class="config-notice-icon"><Connection /></span>
            <span><strong>模型尚未配置</strong><small>服务已启动，配置模型后即可开始对话。</small></span>
          </div>

          <div v-if="assistant.error.value" class="assistant-error" role="alert">
            <span>{{ assistant.error.value }}</span>
            <button class="error-retry" v-if="assistant.retryText.value" @click="assistant.send(assistant.retryText.value)"><Refresh /> 重试</button>
            <button class="icon-button error-dismiss" aria-label="关闭错误提示" @click="assistant.error.value = null"><Close /></button>
          </div>

          <div class="conversation-scroll" :class="{ 'with-sidebar-mode': expanded }">
            <div class="conversation-topline">
              <div>
                <span class="conversation-eyebrow">{{ assistant.currentSession.value ? '当前会话' : '新对话' }}</span>
                <h3>{{ selectedTitle }}</h3>
              </div>
              <span v-if="assistant.currentTask.value" class="task-state" :class="{ active: assistant.taskIsActive.value }">
                <i></i>{{ statusLabel }}
              </span>
            </div>

            <div v-if="assistant.loadingSession.value || assistant.initializing.value" class="loading-history" role="status">
              <span class="loading-pulse"></span>
              <span>正在恢复会话…</span>
            </div>

            <div v-else-if="timeline.length === 0" class="conversation-welcome">
              <div class="welcome-avatar"><MagicStick /></div>
              <span class="welcome-kicker">你好，我是 Pi</span>
              <h3>今天想一起解决什么？</h3>
              <p>你可以从一个问题开始。我会根据当前页面提供的上下文，协助整理想法或检查示例能力。</p>
              <div class="suggestion-list">
                <button @click="usePrompt('检查示例工具能力，并简要说明结果。')">
                  <span class="suggestion-icon"><Connection /></span>
                  <span><strong>检查示例工具能力</strong><small>查看工具调用与结果摘要</small></span>
                  <span class="suggestion-arrow">↗</span>
                </button>
                <button @click="usePrompt('帮我整理一下当前页面的集成要点。')">
                  <span class="suggestion-icon"><ChatDotRound /></span>
                  <span><strong>整理集成要点</strong><small>从当前页面上下文开始</small></span>
                  <span class="suggestion-arrow">↗</span>
                </button>
              </div>
            </div>

            <div v-else class="message-list" aria-live="polite" aria-relevant="additions text">
              <div v-for="item in timeline" :key="`${item.kind}-${item.id}`" class="timeline-entry">
                <article v-if="item.kind === 'message'" class="message" :class="[`message-${item.message.role}`, `message-${item.message.status}`]">
                  <div class="message-avatar" :class="{ assistant: item.message.role === 'assistant' }">
                    <MagicStick v-if="item.message.role === 'assistant'" />
                    <span v-else>你</span>
                  </div>
                  <div class="message-body">
                    <div class="message-meta">
                      <strong>{{ item.message.role === 'assistant' ? 'Pi 助手' : '你' }}</strong>
                      <span>{{ formatTime(item.message.createdAt) }}</span>
                      <span v-if="item.message.status !== 'completed'" class="message-status">{{ messageStatus(item.message.status) }}</span>
                    </div>
                    <div class="markdown-content" :class="{ 'plain-user-content': item.message.role === 'user' }" v-html="renderMarkdown(item.message.text)"></div>
                  </div>
                </article>

                <details v-else class="tool-card" :class="`tool-${item.tool.status}`">
                  <summary>
                    <span class="tool-symbol"><Connection /></span>
                    <span class="tool-summary-copy">
                      <span class="tool-human-label">{{ toolLabel(item.tool) }}</span>
                      <code>{{ item.tool.name }}</code>
                    </span>
                    <span class="tool-status-pill">{{ toolStatus(item.tool.status) }}</span>
                    <span class="tool-chevron">⌄</span>
                  </summary>
                  <div class="tool-details">
                    <div class="tool-detail-block">
                      <span>参数</span>
                      <pre><code>{{ prettyJson(item.tool.arguments) }}</code></pre>
                    </div>
                    <div v-if="item.tool.result !== undefined" class="tool-detail-block">
                      <span>结果</span>
                      <pre><code>{{ prettyJson(item.tool.result) }}</code></pre>
                    </div>
                    <div v-else class="tool-pending-note">{{ toolStatus(item.tool.status) }}，结果将在完成后显示。</div>
                  </div>
                </details>
              </div>

              <div v-if="assistant.taskIsActive.value && !timeline.some((item) => item.kind === 'message' && item.message.status === 'streaming')" class="thinking-line">
                <span class="thinking-avatar"><MagicStick /></span>
                <span class="thinking-dots"><i></i><i></i><i></i></span>
                <span>Pi 正在思考</span>
              </div>
            </div>
          </div>

          <footer class="composer-area">
            <div v-if="assistant.taskIsActive.value" class="active-task-hint">
              <span class="working-pulse"></span>
              <span>任务正在进行。收起面板不会中断任务。</span>
            </div>
            <div class="composer-box" :class="{ focused: assistant.draft.value.length > 0 }">
              <textarea
                v-model="assistant.draft.value"
                aria-label="消息输入框"
                placeholder="给 Pi 助手发送消息…"
                rows="2"
                :disabled="assistant.submitting.value || assistant.taskIsActive.value"
                @keydown="onComposerKeydown"
              ></textarea>
              <div class="composer-controls">
                <span class="composer-hint">Enter 发送 · Shift + Enter 换行</span>
                <button
                  v-if="assistant.taskIsActive.value"
                  class="stop-button"
                  aria-label="停止生成"
                  @click="assistant.stop()"
                >
                  <span class="stop-square"></span>停止
                </button>
                <button
                  v-else
                  class="send-button"
                  aria-label="发送消息"
                  :disabled="assistant.submitting.value || !assistant.draft.value.trim()"
                  @click="submit"
                >
                  <el-icon v-if="assistant.submitting.value" class="is-loading"><Refresh /></el-icon>
                  <ArrowUp v-else />
                </button>
              </div>
            </div>
          </footer>
        </div>
      </section>
    </div>
  </Transition>
</template>

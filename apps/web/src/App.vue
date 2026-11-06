<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowRight, ChatDotRound, Connection, Document, MagicStick } from '@element-plus/icons-vue';
import AssistantShell from './components/AssistantShell.vue';

const activePage = ref<'workspace' | 'integration'>('workspace');
const assistantOpen = ref(false);
const pageContext = computed(() => ({
  page: activePage.value === 'workspace' ? '工作台' : '集成说明',
  surface: 'pi-vue3-demo',
}));
</script>

<template>
  <div class="host-app">
    <header class="host-header">
      <a class="brand" href="#workspace" aria-label="Pi 工作台首页" @click.prevent="activePage = 'workspace'">
        <span class="brand-mark"><MagicStick /></span>
        <span class="brand-copy">
          <strong>Pi</strong>
          <span>ASSISTANT WORKSPACE</span>
        </span>
      </a>

      <nav class="host-nav" aria-label="演示页面导航">
        <button
          class="nav-link"
          :class="{ active: activePage === 'workspace' }"
          :aria-current="activePage === 'workspace' ? 'page' : undefined"
          @click="activePage = 'workspace'"
        >
          <el-icon><ChatDotRound /></el-icon>
          <span>工作台</span>
        </button>
        <button
          class="nav-link"
          :class="{ active: activePage === 'integration' }"
          :aria-current="activePage === 'integration' ? 'page' : undefined"
          @click="activePage = 'integration'"
        >
          <el-icon><Connection /></el-icon>
          <span>集成说明</span>
        </button>
      </nav>

      <div class="header-caption">
        <span class="online-dot"></span>
        <span>本地演示环境</span>
      </div>
    </header>

    <main class="host-main">
      <section v-if="activePage === 'workspace'" class="workspace-page">
        <div class="welcome-panel">
          <div class="welcome-copy">
            <div class="eyebrow"><span class="eyebrow-line"></span> GLOBAL ASSISTANT</div>
            <h1>让对话在每个页面都触手可及。</h1>
            <p>打开右下角的 Pi 助手，继续已有会话，或从当前工作页面发起新的任务。</p>
            <button class="welcome-action" @click="assistantOpen = true">
              打开全局助手
              <el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="welcome-art" aria-hidden="true">
            <div class="art-orbit orbit-one"></div>
            <div class="art-orbit orbit-two"></div>
            <div class="art-core"><MagicStick /></div>
            <div class="art-card card-top"><span class="art-dot teal"></span><span></span><span></span></div>
            <div class="art-card card-bottom"><span class="art-dot blue"></span><span></span><span></span></div>
          </div>
        </div>

        <div class="section-heading">
          <div>
            <span class="section-kicker">从这里开始</span>
            <h2>一个助手，伴随整个工作流</h2>
          </div>
          <span class="section-note">演示应用 · 无需离开当前页面</span>
        </div>

        <div class="feature-grid">
          <article class="feature-card">
            <div class="feature-icon icon-teal"><ChatDotRound /></div>
            <h3>延续上下文</h3>
            <p>会话历史保存在本地服务中。重新打开页面后，可以回到上次的对话。</p>
            <button class="text-action" @click="assistantOpen = true">查看会话 <el-icon><ArrowRight /></el-icon></button>
          </article>
          <article class="feature-card">
            <div class="feature-icon icon-blue"><Connection /></div>
            <h3>任务实时更新</h3>
            <p>助手通过事件流逐步展示回复和工具调用状态，关闭面板后任务仍会继续。</p>
            <button class="text-action" @click="assistantOpen = true">开始对话 <el-icon><ArrowRight /></el-icon></button>
          </article>
          <article class="feature-card">
            <div class="feature-icon icon-sand"><Document /></div>
            <h3>安全呈现内容</h3>
            <p>Markdown 和代码块以清晰的结构显示，富文本内容经过净化后再呈现。</p>
            <button class="text-action" @click="activePage = 'integration'">了解集成 <el-icon><ArrowRight /></el-icon></button>
          </article>
        </div>

        <div class="bottom-note">
          <span class="note-mark"><MagicStick /></span>
          <p>试试在助手中输入“检查示例工具能力”，查看一条完整的任务与工具调用流程。</p>
        </div>
      </section>

      <section v-else class="integration-page">
        <div class="integration-heading">
          <div class="eyebrow"><span class="eyebrow-line"></span> INTEGRATION NOTES</div>
          <h1>把助手放进现有产品体验</h1>
          <p>这个演示展示了全局入口、持久化会话与安全的流式对话交互。</p>
        </div>
        <div class="integration-grid">
          <article class="integration-card">
            <span class="integration-index">01 / CONTEXT</span>
            <h2>页面上下文</h2>
            <p>宿主页面可以向全局助手提供轻量上下文。当前演示会附带页面名称，帮助对话理解用户所在位置。</p>
            <div class="code-line"><code>page: “{{ pageContext.page }}”</code><span>当前页面</span></div>
          </article>
          <article class="integration-card">
            <span class="integration-index">02 / SESSION</span>
            <h2>会话与历史</h2>
            <p>会话列表、重命名、删除和历史消息都由本地 API 提供。首次发送消息时会自动创建会话。</p>
            <div class="code-line"><code>/api/assistant/sessions</code><span>REST API</span></div>
          </article>
          <article class="integration-card">
            <span class="integration-index">03 / STREAM</span>
            <h2>可恢复的事件流</h2>
            <p>客户端按顺序应用任务事件。连接中断或序号缺失时，会请求权威快照后恢复。</p>
            <div class="code-line"><code>text/event-stream</code><span>SSE</span></div>
          </article>
        </div>
        <button class="back-to-workspace" @click="activePage = 'workspace'">
          返回工作台 <el-icon><ArrowRight /></el-icon>
        </button>
      </section>
    </main>

    <footer class="host-footer">
      <span>Pi Assistant</span>
      <span>轻量、全局、可恢复的对话体验</span>
    </footer>

    <AssistantShell v-model:open="assistantOpen" :page-context="pageContext" />
  </div>
</template>

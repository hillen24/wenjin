<script setup lang="ts">
/**
 * 设置
 *
 * AI 那一块是重点：状态带 + 服务商 + BaseURL + Key + 模型 + 拉取 + 测试，
 * 每一步都直接对接 @wenjin/core 的 SettingsStore / AiGate，
 * 中间没有第二份状态副本 —— 所以不会再出现「设置页显示成功、侧栏显示失败」。
 */

import { computed, onBeforeUnmount, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  EDGE_VOICES,
  PROVIDERS,
  type AiStatus,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
  type TtsEngine,
} from '@wenjin/core';
import { useCore } from '../providers';
import LanSync from '../sync/LanSync.vue';

const core = useCore();

const s = ref<Settings>(core.settings.get());
const aiStatus = ref<AiStatus>(core.ai.status);

const offSettings = core.settings.subscribe((next) => {
  s.value = next;
});
const offAi = core.ai.subscribe((st) => {
  aiStatus.value = st;
});

/* ---------------- AI 区块 ---------------- */

/**
 * 注意：ProviderDef 自己也叫 key，但那是「是否需要 API Key」的布尔值。
 * 用 id 承载服务商标识，避免和它撞名后被覆盖。
 */
const providers = Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p }));

const fetching = ref(false);
const testing = ref(false);
const modelOptions = ref<string[]>([]);
const hint = ref('');

const statusTone = computed(() => {
  switch (aiStatus.value.state) {
    case 'verified':
      return 'ok';
    case 'verifying':
      return 'testing';
    case 'failed':
      return 'bad';
    default:
      return 'warn';
  }
});

const statusText = computed(() => {
  const st = aiStatus.value;
  switch (st.state) {
    case 'verified':
      return `已接入 · ${st.provider} / ${st.model}`;
    case 'verifying':
      return '正在向服务发一次真实对话 …';
    case 'unconfigured':
      return '未配置 · 现在走预置脚本';
    case 'failed':
      return `连接失败 · ${st.reason}`;
    case 'unverified':
      return '待验证 · 配置已填好，点「测试连接」，或直接去用（会自动验证一次）';
  }
});

const currentProvider = computed(() => PROVIDERS[s.value.primary]);

function setProvider(key: string): void {
  core.settings.setProvider(key);
  modelOptions.value = [];
  hint.value = '';
}

function update<K extends keyof Settings>(key: K, value: Settings[K]): void {
  const patch = { [key]: value } as SettingsPatch;
  core.settings.patch(patch);
}

function onText(key: 'baseURL' | 'apiKey' | 'model', e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  update(key, v);
}

async function fetchModels(): Promise<void> {
  fetching.value = true;
  hint.value = '';
  const r = await core.ai.fetchModels();
  fetching.value = false;
  if (r.ok) {
    modelOptions.value = r.ids;
    hint.value = `已拉到 ${r.ids.length} 个模型 · 下拉选择或保持手填`;
  } else {
    hint.value = `拉取失败：${r.reason}`;
  }
}

async function testConnection(): Promise<void> {
  testing.value = true;
  hint.value = '';
  const r = await core.ai.testConnection();
  testing.value = false;

  if (r.status.state === 'verified') {
    hint.value = `连接成功 · 回声「${r.brief}」`;
  } else if (r.status.state === 'failed') {
    hint.value = r.status.reason;
  } else {
    hint.value = '连接失败';
  }
}

/* ---------------- 外观与语音 ---------------- */

const THEMES: { key: ThemeMode; label: string }[] = [
  { key: 'dark', label: '黑天' },
  { key: 'light', label: '白天' },
];

const ENGINES: { key: TtsEngine; label: string }[] = [
  { key: 'browser', label: '系统内置' },
  { key: 'edge', label: 'Edge 音色' },
  { key: 'custom', label: '自建服务' },
];

function pickTheme(t: ThemeMode): void {
  core.theme.apply(t);
}

onBeforeUnmount(() => {
  offSettings();
  offAi();
});
</script>

<template>
  <div class="settings">
    <div class="inner">
      <!-- ================= AI 服务 ================= -->
      <section>
        <header>
          <h2>AI 服务</h2>
          <p>填好后会立刻真实探测一次，不用你记得点按钮。</p>
        </header>

        <div class="state" :class="statusTone">
          <span class="dot" />
          <span>{{ statusText }}</span>
        </div>

        <div class="field">
          <label>服务商</label>
          <div class="chips">
            <button
              v-for="p in providers"
              :key="p.id"
              type="button"
              class="chip"
              :class="{ on: s.provider === p.id }"
              @click="setProvider(p.id)"
            >
              {{ p.name }}
            </button>
          </div>
          <p class="note">{{ currentProvider?.note }}</p>
        </div>

        <div class="field">
          <label for="base">Base URL</label>
          <input
            id="base"
            type="text"
            :value="s.baseURL"
            placeholder="https://api.deepseek.com/v1"
            spellcheck="false"
            @change="onText('baseURL', $event)"
          />
        </div>

        <div class="field">
          <label for="key">
            API Key
            <span v-if="!currentProvider?.key" class="opt">本地服务不需要</span>
          </label>
          <input
            id="key"
            type="password"
            :value="s.apiKey"
            :disabled="!currentProvider?.key"
            placeholder="sk-…"
            spellcheck="false"
            autocomplete="off"
            @change="onText('apiKey', $event)"
          />
        </div>

        <div class="field">
          <label for="model">模型</label>
          <div class="row">
            <input
              id="model"
              type="text"
              :value="s.model"
              placeholder="deepseek-chat"
              spellcheck="false"
              @change="onText('model', $event)"
            />
            <button type="button" class="btn ghost" :disabled="fetching" @click="fetchModels">
              <Icon name="i-refresh" :size="14" />
              {{ fetching ? '拉取中…' : '拉取' }}
            </button>
          </div>
          <select
            v-if="modelOptions.length"
            class="model-select"
            :value="s.model"
            @change="onText('model', $event)"
          >
            <option value="">— 拉到 {{ modelOptions.length }} 个，选一个自动填入 —</option>
            <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>

        <div class="actions">
          <button type="button" class="btn primary" :disabled="testing" @click="testConnection">
            <Icon name="i-check" :size="14" />
            {{ testing ? '测试中…' : '测试连接' }}
          </button>
          <span v-if="hint" class="hint">{{ hint }}</span>
        </div>
      </section>

      <!-- ================= 外观 ================= -->
      <section>
        <header>
          <h2>外观</h2>
        </header>

        <div class="field">
          <label>主题</label>
          <div class="chips">
            <button
              v-for="t in THEMES"
              :key="t.key"
              type="button"
              class="chip"
              :class="{ on: s.theme === t.key }"
              @click="pickTheme(t.key)"
            >
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="field">
          <label for="fs">正文字号 · {{ s.fontSize }}px</label>
          <input
            id="fs"
            type="range"
            min="12"
            max="28"
            step="1"
            :value="s.fontSize"
            @input="update('fontSize', Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </section>

      <!-- ================= 局域网同步 ================= -->
      <section>
        <header>
          <h2>局域网同步</h2>
          <p>同一 Wi-Fi 下，把一台的记录整体搬到另一台。覆盖方向由你点，覆盖前自动备份。</p>
        </header>

        <LanSync />
      </section>

      <!-- ================= 语音 ================= -->
      <section>
        <header>
          <h2>语音朗读</h2>
        </header>

        <div class="field">
          <label>引擎</label>
          <div class="chips">
            <button
              v-for="e in ENGINES"
              :key="e.key"
              type="button"
              class="chip"
              :class="{ on: s.ttsEngine === e.key }"
              @click="update('ttsEngine', e.key)"
            >
              {{ e.label }}
            </button>
          </div>
        </div>

        <div v-if="s.ttsEngine === 'edge'" class="field">
          <label for="voice">Edge 音色</label>
          <select
            id="voice"
            :value="s.ttsEdgeVoice"
            @change="update('ttsEdgeVoice', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="v in EDGE_VOICES" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
        </div>

        <div class="field">
          <label for="rate">语速 · {{ s.ttsRate.toFixed(2) }}×</label>
          <input
            id="rate"
            type="range"
            min="0.5"
            max="2"
            step="0.05"
            :value="s.ttsRate"
            @input="update('ttsRate', Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  height: 100%;
  overflow-y: auto;
}

.inner {
  max-width: 620px;
  margin: 0 auto;
  padding: 32px 28px 60px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

section {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px;
}

header {
  margin-bottom: 16px;
}

h2 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 500;
}

header p {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink3);
}

/* ---------- 状态带 ---------- */

.state {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
  margin-bottom: 18px;
  background: var(--field);
  border: 1px solid var(--line);
}

.state .dot {
  width: 7px;
  height: 7px;
  flex: none;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--ink3);
}

.state.ok {
  border-color: var(--jade-soft);
  background: var(--jade-soft);
  color: var(--jade-deep);
}

.state.ok .dot {
  background: var(--jade);
}

.state.warn .dot {
  background: var(--gold);
}

.state.bad {
  border-color: var(--accent-soft);
  background: var(--accent-soft);
  color: var(--accent);
}

.state.bad .dot {
  background: var(--accent);
}

.state.testing .dot {
  background: var(--steel);
  animation: pulse 1.2s var(--ease) infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

/* ---------- 表单 ---------- */

.field {
  margin-bottom: 16px;
}

.field:last-child {
  margin-bottom: 0;
}

label {
  display: block;
  font-size: 12.5px;
  color: var(--ink2);
  margin-bottom: 7px;
}

label .opt {
  font-size: 11.5px;
  color: var(--ink3);
  margin-left: 6px;
}

input[type='text'],
input[type='password'],
select {
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--line);
  font-size: 13px;
  outline: none;
  transition: border-color 0.16s;
}

input[type='text']:focus,
input[type='password']:focus,
select:focus {
  border-color: var(--accent);
}

input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

input[type='range'] {
  width: 100%;
  accent-color: var(--accent);
}

.row {
  display: flex;
  gap: 8px;
}

.row input {
  flex: 1;
  min-width: 0;
}

.model-select {
  margin-top: 8px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.chip {
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--field);
  border: 1px solid var(--line);
  color: var(--ink2);
  font-size: 12.5px;
  transition: all 0.16s var(--ease);
}

.chip:hover {
  border-color: var(--line-hi);
  color: var(--ink);
}

.chip.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.note {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--ink3);
}

/* ---------- 按钮 ---------- */

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  transition: background 0.16s;
}

.btn svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
}

.btn.primary {
  background: var(--accent);
  color: var(--accent-ink);
}

.btn.primary:hover:not(:disabled) {
  background: var(--accent-hi);
}

.btn.ghost {
  background: var(--field);
  border: 1px solid var(--line);
  color: var(--ink2);
  flex: none;
}

.btn.ghost:hover:not(:disabled) {
  border-color: var(--line-hi);
  color: var(--ink);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.hint {
  font-size: 12px;
  color: var(--ink3);
  line-height: 1.5;
}
/* ============================================================
 * 窄屏（手机）
 *
 * 表单本来就是单列自适应，只需要收窄留白、加大可点区域。
 * ============================================================ */

@media (max-width: 760px) {
  .inner {
    padding: 18px 14px 48px;
    gap: 14px;
  }

  section {
    padding: 16px 14px;
  }

  /* 手机上输入框太矮会误触，顺手把高度撑到 44px 附近 */
  input[type='text'],
  input[type='password'],
  select {
    padding: 11px 12px;
    font-size: 15px;
  }

  .chip {
    padding: 8px 14px;
    font-size: 13px;
  }
}
</style>

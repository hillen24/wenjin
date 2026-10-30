<script setup lang="ts">
/**
 * 设置
 *
 * AI 那一块是重点：状态带 + 服务商 + BaseURL + Key + 模型 + 拉取 + 测试，
 * 每一步都直接对接 @wenjin/core 的 SettingsStore / AiGate，
 * 中间没有第二份状态副本 —— 所以不会再出现「设置页显示成功、侧栏显示失败」。
 */

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  EDGE_VOICES,
  PROVIDERS,
  TTS_FORMATS,
  TTS_PROVIDERS,
  describeSnapshot,
  parseBackupFile,
  type AiStatus,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
  type TtsEngine,
  type VoiceOption,
} from '@wenjin/core';
import { useCore } from '../providers';
import LanSync from '../sync/LanSync.vue';
import { reloadSoon } from '../sync/lan';
import {
  autoBackup,
  exportBackup,
  isDesktop,
  listBackups,
  readBackup,
  removeBackup,
  restoreBackupText,
  type AutoBackupInfo,
} from '../sync/backup';

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

function onText(key: 'baseURL' | 'apiKey' | 'model' | 'ttsBaseURL', e: Event): void {
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

const ENGINES: { key: TtsEngine; label: string; desc: string }[] = [
  { key: 'browser', label: '系统内置', desc: '用手机/电脑自带的语音。零配置，但音色质量看系统。' },
  { key: 'edge', label: 'Edge 音色', desc: '走 edge-tts 桥接服务。音质最好，需要电脑上有桥。' },
  { key: 'custom', label: '云端 API', desc: '接你自己的 TTS 服务（OpenAI 兼容）。手机上唯一能出声的办法。' },
];

/* ---------------- 自定义 TTS ---------------- */

const ttsProviders = Object.entries(TTS_PROVIDERS).map(([id, p]) => ({ id, ...p }));

const ttsProviderDef = computed(() => TTS_PROVIDERS[s.value.ttsProvider] ?? TTS_PROVIDERS.custom!);

/**
 * 切换服务商时，把该服务商的默认值填进去。
 *
 * 但只填「还等于上一个默认值的字段」—— 用户手改过的地址/Key 不能被冲掉。
 * 这是设置页最容易招骂的地方：点一下别的服务商，刚填的 Key 没了。
 */
function setTtsProvider(id: string): void {
  const prev = TTS_PROVIDERS[s.value.ttsProvider];
  const next = TTS_PROVIDERS[id];
  if (!next) return;

  const patch: SettingsPatch = { ttsProvider: id };

  // 地址：手改过就保留
  if (prev && s.value.ttsApiBase === prev.base) patch.ttsApiBase = next.base;
  else if (!s.value.ttsApiBase) patch.ttsApiBase = next.base;

  // 模型 / 音色同理
  if (prev && s.value.ttsApiModel === prev.model) patch.ttsApiModel = next.model;
  else if (!s.value.ttsApiModel) patch.ttsApiModel = next.model;

  if (prev && s.value.ttsApiVoice === prev.voice) patch.ttsApiVoice = next.voice;
  else if (!s.value.ttsApiVoice) patch.ttsApiVoice = next.voice;

  patch.ttsApiFormat = next.format;

  core.settings.patch(patch);
  ttsHint.value = '';
}

const ttsTesting = ref(false);
const ttsHint = ref('');
const ttsVoiceOptions = ref<VoiceOption[]>([]);
const ttsLoadingVoices = ref(false);
const ttsAdvanced = ref(false);

/** 语音引擎当前是否可用（有可用的合成通道）。手机端没有系统语音，要提示。 */
const engineNote = computed(() => ENGINES.find((e) => e.key === s.value.ttsEngine)?.desc ?? '');

/** 当前服务商推荐的音色（供下拉选择）。自定义服务商没有预设。 */
const presetVoices = computed(() => ttsProviderDef.value.voices ?? []);

function onTtsText(key: string, e: Event): void {
  const v = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
  core.settings.patch({ [key]: v } as SettingsPatch);
  ttsHint.value = '';
}

async function testTts(): Promise<void> {
  ttsTesting.value = true;
  ttsHint.value = '';
  const r = await core.tts.probe();
  ttsTesting.value = false;
  ttsHint.value = r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`;
}

async function loadTtsVoices(): Promise<void> {
  ttsLoadingVoices.value = true;
  ttsHint.value = '';
  const r = await core.tts.listRemoteVoices();
  ttsLoadingVoices.value = false;
  ttsVoiceOptions.value = r.voices;
  ttsHint.value = r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`;
}

function pickTtsVoice(v: VoiceOption): void {
  core.settings.patch({ ttsApiVoice: v.id });
  ttsHint.value = `已选音色 ${v.name}`;
}

function pickTheme(t: ThemeMode): void {
  core.theme.apply(t);
}

/* ---------------- 数据备份 ---------------- */

const desktop = isDesktop();
const bkBusy = ref(false);
const bkHint = ref('');
const bkList = ref<AutoBackupInfo[]>([]);
const bkDir = ref('');

/** 待确认的恢复：文件已选、内容已校验，等用户再点一次「确认恢复」 */
const bkPending = ref<{ text: string; summary: string } | null>(null);
const bkArmed = ref(false);

function fmtTime(at: number): string {
  if (!at) return '未知时间';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function refreshBackups(): Promise<void> {
  bkList.value = await listBackups();
}

onMounted(async () => {
  void refreshBackups();
  if (desktop) {
    try {
      const b = window.wjBridge;
      if (b) bkDir.value = await b.backupDir();
    } catch {
      /* 拿不到目录路径只是少显示一行，不影响备份 */
    }
  }
});

async function doExport(): Promise<void> {
  bkBusy.value = true;
  bkHint.value = '';
  const r = await exportBackup();
  bkBusy.value = false;
  bkHint.value = r.ok
    ? r.where === 'disk'
      ? '备份文件已保存'
      : '备份文件已开始下载'
    : r.reason;
}

/** 手动触发一次自动备份（等不到入库/退出，现在就要一份） */
async function doAutoBackup(): Promise<void> {
  bkBusy.value = true;
  const r = await autoBackup('手动备份');
  bkBusy.value = false;
  void refreshBackups();
  bkHint.value = r.ok
    ? r.where === 'disk'
      ? '已备份到本机磁盘'
      : '已备份到本机存储'
    : `备份失败：${r.reason}`;
}

async function onImportFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  const text = await f.text();
  // 先解析校验，告诉用户这份备份里有什么，再等一次确认——
  // 恢复是覆盖式操作，不能让用户蒙着眼睛点下去。
  // 注意这里只能用纯解析：带副作用的恢复留到用户点「确认恢复」之后。
  let summary = '';
  try {
    const raw = JSON.parse(text);
    const r = parseBackupFile(raw);
    if (!r.ok) {
      bkHint.value = `这份备份用不了：${r.reason}`;
      return;
    }
    const st = describeSnapshot(r.snap);
    summary = `含 ${st.keys} 项数据 · 格物卡 ${st.cards} · 论道 ${st.debates} · 藏书 ${st.books}`;
  } catch {
    bkHint.value = '这份备份用不了：不是合法的 JSON 文件';
    return;
  }
  bkPending.value = { text, summary };
  bkArmed.value = true;
  window.setTimeout(() => {
    bkArmed.value = false;
  }, 5000);
}

async function doRestore(text: string): Promise<void> {
  bkBusy.value = true;
  const r = restoreBackupText(text);
  bkBusy.value = false;
  bkPending.value = null;
  if (!r.ok) {
    bkHint.value = `恢复失败：${r.reason}`;
    return;
  }
  bkHint.value = '已从备份恢复（恢复前的数据也自动留了一份）· 即将重载…';
  reloadSoon();
}

async function restoreFromList(b: AutoBackupInfo): Promise<void> {
  bkBusy.value = true;
  const text = await readBackup(b.key);
  bkBusy.value = false;
  if (!text) {
    bkHint.value = '这份备份读不出来了';
    return;
  }
  await doRestore(text);
}

async function removeFromList(b: AutoBackupInfo): Promise<void> {
  await removeBackup(b.key);
  void refreshBackups();
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

      <!-- ================= 数据备份 ================= -->
      <section>
        <header>
          <h2>数据备份</h2>
          <p>
            换设备搬家靠上面那个；防误操作、防存储抽风，靠这里。{{
              desktop
                ? '电脑端每次文献入库前、退出前都会自动备份到本机磁盘，保留最近 10 份。'
                : '手机端自动备份留在本机存储，保留最近 3 份；重要备份请用「导出备份文件」另存一份。'
            }}
          </p>
        </header>

        <div class="bk-actions">
          <button type="button" class="btn primary" :disabled="bkBusy" @click="doExport">
            <Icon name="i-download" :size="14" />
            {{ bkBusy ? '处理中…' : '导出备份文件' }}
          </button>
          <button type="button" class="btn ghost" :disabled="bkBusy" @click="doAutoBackup">
            <Icon name="i-file" :size="14" /> 立即备份一次
          </button>
          <label class="btn ghost bk-file">
            <Icon name="i-upload" :size="14" /> 从备份恢复
            <input id="bk-file" type="file" accept=".json,application/json" @change="onImportFile" />
          </label>
        </div>

        <p v-if="bkPending" class="bk-confirm" :class="{ armed: bkArmed }">
          <Icon name="i-warn" :size="14" />
          <span>
            恢复将<b>整包覆盖</b>当前数据（{{ bkPending.summary }}）。恢复前的数据会自动留一份。
          </span>
          <button type="button" class="btn primary sm" :disabled="!bkArmed" @click="doRestore(bkPending!.text)">
            确认恢复
          </button>
          <button type="button" class="btn ghost sm" @click="bkPending = null">取消</button>
        </p>

        <div v-if="bkList.length" class="bk-list">
          <div class="bk-head">
            <span>自动备份（{{ desktop ? '本机磁盘' : '本机存储' }}，最近 {{ bkList.length }} 份）</span>
            <span v-if="desktop && bkDir" class="bk-dir" :title="bkDir">{{ bkDir }}</span>
          </div>
          <div v-for="b in bkList" :key="b.key" class="bk-row">
            <span class="bk-time">{{ fmtTime(b.at) }}</span>
            <span class="bk-reason">{{ b.reason }}</span>
            <span class="bk-size">{{ fmtSize(b.bytes) }}</span>
            <button type="button" class="btn ghost sm" :disabled="bkBusy" @click="restoreFromList(b)">恢复</button>
            <button type="button" class="btn ghost sm" @click="removeFromList(b)">删除</button>
          </div>
        </div>

        <p v-if="bkHint" class="hint">{{ bkHint }}</p>
      </section>

      <!-- ================= 语音 ================= -->
      <section>
        <header>
          <h2>语音朗读</h2>
          <p>{{ engineNote }}</p>
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

        <div v-if="s.ttsEngine === 'edge'" class="field">
          <label for="edgeBase">桥接服务地址</label>
          <input
            id="edgeBase"
            type="text"
            :value="s.ttsBaseURL"
            placeholder="http://127.0.0.1:8787/v1"
            spellcheck="false"
            @change="onText('ttsBaseURL', $event)"
          />
          <p class="note">
            电脑本机用 <code>http://127.0.0.1:8787/v1</code>；
            手机要填电脑的局域网 IP（如 <code>http://192.168.1.5:8787/v1</code>），
            两台要在同一个 Wi-Fi 下。
          </p>
        </div>

        <!-- ---------- 自定义 TTS ---------- -->
        <template v-if="s.ttsEngine === 'custom'">
          <div class="field">
            <label>服务商</label>
            <div class="chips">
              <button
                v-for="p in ttsProviders"
                :key="p.id"
                type="button"
                class="chip"
                :class="{ on: s.ttsProvider === p.id }"
                @click="setTtsProvider(p.id)"
              >
                {{ p.name }}
              </button>
            </div>
            <p class="note">{{ ttsProviderDef.note }}</p>
          </div>

          <div class="field">
            <label for="ttsBase">接口地址</label>
            <input
              id="ttsBase"
              type="text"
              :value="s.ttsApiBase"
              :placeholder="ttsProviderDef.base || 'https://…/v1'"
              spellcheck="false"
              @change="onTtsText('ttsApiBase', $event)"
            />
            <p class="note">要带 /v1 这类前缀。留空则用服务商的默认地址。</p>
          </div>

          <div class="field">
            <label for="ttsKey">API Key</label>
            <input
              id="ttsKey"
              type="password"
              :value="s.ttsApiKey"
              placeholder="sk-…"
              spellcheck="false"
              autocomplete="off"
              @change="onTtsText('ttsApiKey', $event)"
            />
            <p class="note">只存在这台设备上，不会上传到别处。</p>
          </div>

          <div class="field">
            <label for="ttsModel">模型</label>
            <input
              id="ttsModel"
              type="text"
              :value="s.ttsApiModel"
              :placeholder="ttsProviderDef.model || '模型名'"
              spellcheck="false"
              @change="onTtsText('ttsApiModel', $event)"
            />
          </div>

          <div class="field">
            <label for="ttsVoice">音色</label>
            <div class="row">
              <input
                id="ttsVoice"
                type="text"
                :value="s.ttsApiVoice"
                :placeholder="ttsProviderDef.voice || '音色名'"
                spellcheck="false"
                @change="onTtsText('ttsApiVoice', $event)"
              />
              <button type="button" class="btn ghost" :disabled="ttsLoadingVoices" @click="loadTtsVoices">
                <Icon name="i-refresh" :size="14" />
                {{ ttsLoadingVoices ? '拉取中…' : '拉取' }}
              </button>
            </div>
            <select
              v-if="presetVoices.length"
              class="model-select"
              :value="s.ttsApiVoice"
              @change="onTtsText('ttsApiVoice', $event)"
            >
              <option value="">— 选一个常用音色 —</option>
              <option v-for="v in presetVoices" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
            <select
              v-if="ttsVoiceOptions.length"
              class="model-select"
              :value="s.ttsApiVoice"
              @change="pickTtsVoice(ttsVoiceOptions.find((v) => v.id === ($event.target as HTMLSelectElement).value)!)"
            >
              <option value="">— 服务端返回的 {{ ttsVoiceOptions.length }} 个音色 —</option>
              <option
                v-for="v in ttsVoiceOptions"
                :key="v.id"
                :value="v.id"
              >{{ v.name }}</option>
            </select>
          </div>

          <div class="field">
            <label for="ttsFormat">音频格式</label>
            <select
              id="ttsFormat"
              :value="s.ttsApiFormat"
              @change="onTtsText('ttsApiFormat', $event)"
            >
              <option v-for="f in TTS_FORMATS" :key="f" :value="f">{{ f }}</option>
            </select>
            <p class="note">mp3 最通用；wav 无损但体积大；opus 更省流量。</p>
          </div>

          <div class="field">
            <label>高级</label>
            <button type="button" class="btn ghost wide" @click="ttsAdvanced = !ttsAdvanced">
              <Icon name="i-gear" :size="14" />
              {{ ttsAdvanced ? '收起' : '端点 / 请求头 / 请求体' }}
            </button>
          </div>

          <template v-if="ttsAdvanced">
            <div class="field">
              <label for="ttsPath">端点路径</label>
              <input
                id="ttsPath"
                type="text"
                :value="s.ttsApiPath"
                placeholder="/audio/speech"
                spellcheck="false"
                @change="onTtsText('ttsApiPath', $event)"
              />
              <p class="note">也可直接填完整 URL。默认 /audio/speech（OpenAI 兼容）。</p>
            </div>

            <div class="field">
              <label for="ttsHeaders">附加请求头</label>
              <textarea
                id="ttsHeaders"
                rows="3"
                :value="s.ttsApiHeaders"
                placeholder='{"api-key": "xxx"}'
                spellcheck="false"
                @change="onTtsText('ttsApiHeaders', $event)"
              />
              <p class="note">JSON 对象。给 Azure 之类非 Bearer 认证用。</p>
            </div>

            <div class="field">
              <label for="ttsBody">附加请求参数</label>
              <textarea
                id="ttsBody"
                rows="3"
                :value="s.ttsApiBody"
                placeholder='{"gain": 0, "sample_rate": 32000}'
                spellcheck="false"
                @change="onTtsText('ttsApiBody', $event)"
              />
              <p class="note">JSON 对象，会并进请求体。siliconflow 的 gain / sample_rate 在这儿填。</p>
            </div>
          </template>

          <div class="actions">
            <button type="button" class="btn primary" :disabled="ttsTesting" @click="testTts">
              <Icon name="i-check" :size="14" />
              {{ ttsTesting ? '合成中…' : '测试朗读' }}
            </button>
            <span v-if="ttsHint" class="hint">{{ ttsHint }}</span>
          </div>
        </template>

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

        <div class="field">
          <label>
            <input
              type="checkbox"
              :checked="s.ttsContinuous"
              @change="update('ttsContinuous', ($event.target as HTMLInputElement).checked)"
            />
            连续朗读（一段读完自动接下一段）
          </label>
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
select,
textarea {
  width: 100%;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--line);
  font-size: 13px;
  outline: none;
  transition: border-color 0.16s;
  font-family: inherit;
}

input[type='text']:focus,
input[type='password']:focus,
select:focus,
textarea:focus {
  border-color: var(--accent);
}

/* JSON 输入框：用等宽字体，缩进看得见 */
textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
  min-height: 64px;
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

/* 撑满一行的次要按钮（高级设置折叠用） */
.btn.wide {
  width: 100%;
  justify-content: center;
}

.hint {
  font-size: 12px;
  color: var(--ink3);
  line-height: 1.5;
}

/* 设置页里的 code 值（地址、路径），别让它撑破行宽 */
.note code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--field);
  border: 1px solid var(--line);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}

/* 复选框行：勾选框在左，字在右，别让 label 的 display:block 把它们拆成两行 */
label:has(input[type='checkbox']) {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

label input[type='checkbox'] {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  flex: none;
  margin: 0;
}

/* ---------- 数据备份 ---------- */

.bk-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.bk-file input {
  display: none;
}

.bk-confirm {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px;
  margin: 0 0 14px;
  border-radius: var(--radius-sm);
  background: var(--field);
  border: 1px solid var(--line);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink2);
}

.bk-confirm svg {
  fill: none;
  stroke: var(--gold);
  flex: none;
}

.bk-confirm.armed {
  border-color: var(--accent-soft);
}

.bk-confirm b {
  color: var(--ink);
}

.bk-confirm .btn {
  flex: none;
}

.bk-list {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.bk-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  background: var(--field);
  font-size: 12px;
  color: var(--ink3);
}

.bk-dir {
  font-family: var(--mono);
  font-size: 10.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}

.bk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  font-size: 12.5px;
}

.bk-row:first-child {
  border-top: none;
}

.bk-time {
  font-family: var(--mono);
  color: var(--ink2);
  flex: none;
}

.bk-reason {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}

.bk-size {
  color: var(--ink3);
  flex: none;
}

.bk-row .btn {
  flex: none;
  padding: 4px 10px;
  font-size: 12px;
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

  /* 备份行在窄屏换行：时间/原因一行，按钮跟size一行 */
  .bk-row {
    flex-wrap: wrap;
    row-gap: 6px;
  }

  .bk-reason {
    flex-basis: 100%;
    order: 3;
  }

  .bk-head {
    flex-direction: column;
    gap: 2px;
  }

  .bk-dir {
    max-width: 100%;
  }
}
</style>

<script setup lang="ts">
/**
 * 局域网同步面板
 *
 * 电脑端和手机端共用这一个组件，但它做的事完全不同 —— 因为两端的角色不同：
 *   电脑端：自己是服务端，这里只负责"把地址亮出来"；
 *   手机端：连对方，这里负责填地址、测连接、拉取、推送。
 *
 * 覆盖方向永远由用户点，不做自动合并（理由见 core/sync）。
 */

import { computed, onMounted, ref } from 'vue';
import { Icon } from '@wenjin/ui';
import {
  DEFAULT_PORT,
  applyIncoming,
  fetchRemoteSnapshot,
  lastBackup,
  localStats,
  localSnapshot,
  normalizeHost,
  ping,
  readHost,
  reloadSoon,
  sendSnapshot,
  writeHost,
  type LanInfo,
  type PingInfo,
} from '../sync/lan';

const bridge = typeof window !== 'undefined' ? window.wjBridge : undefined;
const isDesktop = !!bridge;

const host = ref(readHost());
const busy = ref<'' | 'test' | 'pull' | 'push'>('');
const tone = ref<'idle' | 'ok' | 'err'>('idle');
const status = ref('');
const remote = ref<PingInfo | null>(null);
const info = ref<LanInfo | null>(null);
const confirmStep = ref<'' | 'pull' | 'push'>('');
const copied = ref(false);

const mine = ref(localStats());
const backupKey = ref(lastBackup());

const localLine = computed(() => {
  const s = mine.value;
  if (!s) return '本机数据读不出来（存储不可用）';
  return `本机：格物卡 ${s.cards} · 论道 ${s.debates} · 藏书 ${s.books} · 点亮 ${s.lit}`;
});

const addr = computed(() => (info.value ? `http://${info.value.ip}:${info.value.port}` : ''));

onMounted(async () => {
  if (bridge) {
    try {
      info.value = await bridge.info();
    } catch {
      info.value = null;
    }
    return;
  }
  if (host.value) {
    // 填过地址就静默探一下，省得用户每次都点测试
    const r = await ping(host.value);
    if (r.ok) {
      remote.value = r.value;
      tone.value = 'ok';
      status.value = `已连上 ${r.value.host}（${r.value.device} · v${r.value.version}）`;
    }
  }
});

function setStatus(t: 'idle' | 'ok' | 'err', text: string): void {
  tone.value = t;
  status.value = text;
}

async function copyAddr(): Promise<void> {
  if (!addr.value) return;
  try {
    await navigator.clipboard.writeText(addr.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    setStatus('err', '剪贴板被拦了，手动抄一下上面的地址吧');
  }
}

async function test(): Promise<void> {
  const h = normalizeHost(host.value);
  if (!h) {
    setStatus('err', '先填电脑的地址');
    return;
  }
  writeHost(h);
  host.value = h;
  busy.value = 'test';
  const r = await ping(h);
  busy.value = '';
  if (!r.ok) {
    remote.value = null;
    setStatus('err', r.reason);
    return;
  }
  remote.value = r.value;
  setStatus(
    'ok',
    `已连上 ${r.value.host}（${r.value.device} · v${r.value.version}）· 电脑上有格物卡 ${r.value.cards} 张、藏书 ${r.value.books} 本`,
  );
}

async function doPull(): Promise<void> {
  if (confirmStep.value !== 'pull') {
    confirmStep.value = 'pull';
    setStatus('idle', '拉取会用电脑的数据覆盖本机（覆盖前自动备份一份），再点一次确认');
    return;
  }
  confirmStep.value = '';
  const h = normalizeHost(host.value);
  busy.value = 'pull';
  const r = await fetchRemoteSnapshot(h);
  if (!r.ok) {
    busy.value = '';
    setStatus('err', r.reason);
    return;
  }
  const applied = applyIncoming(r.value);
  busy.value = '';
  if (!applied.ok) {
    setStatus('err', `写入失败：${applied.reason ?? '未知原因'}`);
    return;
  }
  setStatus('ok', '已用电脑的数据覆盖本机，正在重载…');
  reloadSoon();
}

async function doPush(): Promise<void> {
  if (confirmStep.value !== 'push') {
    confirmStep.value = 'push';
    setStatus('idle', '推送会用手机的数据覆盖电脑（电脑端会先自动备份一份），再点一次确认');
    return;
  }
  confirmStep.value = '';
  const snap = localSnapshot('手机');
  if (!snap) {
    setStatus('err', '本机数据读不出来');
    return;
  }
  busy.value = 'push';
  const r = await sendSnapshot(normalizeHost(host.value), snap);
  busy.value = '';
  if (!r.ok) {
    setStatus('err', r.reason);
    return;
  }
  setStatus('ok', '已推送到电脑，电脑端会自动备份并重载');
}

function cancelConfirm(): void {
  confirmStep.value = '';
  setStatus('idle', '');
}
</script>

<template>
  <!-- ============ 电脑端：只负责把地址亮出来 ============ -->
  <div v-if="isDesktop" class="lan">
    <div class="addr-box">
      <div class="addr-label">手机要连的地址</div>
      <div class="addr">{{ addr || '正在取本机 IP…' }}</div>
      <button type="button" class="btn ghost sm" :disabled="!addr" @click="copyAddr">
        <Icon name="i-link" :size="13" />
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>

    <p class="note">
      手机和电脑连同一个 Wi-Fi，在手机端「设置 → 局域网同步」里填上面的地址即可。
      端口默认 {{ DEFAULT_PORT }}；若 Windows 弹出防火墙提示，选择「允许访问」。
    </p>

    <p class="state" :class="tone">
      <Icon :name="info ? 'i-check' : 'i-warn'" :size="13" />
      {{ info ? `同步服务已在运行（${info.host} · v${info.version}）` : '同步服务没起来：可能是端口被占用' }}
    </p>

    <p class="state idle">{{ localLine }}</p>
  </div>

  <!-- ============ 手机端：连过去 ============ -->
  <div v-else class="lan">
    <div class="field">
      <label for="lan-host">电脑地址</label>
      <div class="row">
        <input
          id="lan-host"
          v-model="host"
          type="text"
          inputmode="url"
          autocapitalize="off"
          spellcheck="false"
          placeholder="192.168.1.8:47800"
          @change="writeHost(host)"
        />
        <button type="button" class="btn ghost" :disabled="busy === 'test'" @click="test">
          <Icon name="i-refresh" :size="14" />
          {{ busy === 'test' ? '连接中…' : '测试' }}
        </button>
      </div>
      <p class="note">在电脑端「设置 → 局域网同步」里能直接看到这串地址。只填 IP 会自动补 :{{ DEFAULT_PORT }}。</p>
    </div>

    <div class="actions">
      <button
        type="button"
        class="btn"
        :class="confirmStep === 'pull' ? 'primary' : 'ghost'"
        :disabled="!!busy"
        @click="doPull"
      >
        <Icon name="i-download" :size="14" />
        {{ busy === 'pull' ? '拉取中…' : confirmStep === 'pull' ? '确认覆盖本机' : '从电脑拉取' }}
      </button>
      <button
        type="button"
        class="btn"
        :class="confirmStep === 'push' ? 'primary' : 'ghost'"
        :disabled="!!busy"
        @click="doPush"
      >
        <Icon name="i-upload" :size="14" />
        {{ busy === 'push' ? '推送中…' : confirmStep === 'push' ? '确认覆盖电脑' : '推送到电脑' }}
      </button>
      <button v-if="confirmStep" type="button" class="btn ghost sm" @click="cancelConfirm">取消</button>
    </div>

    <p v-if="status" class="state" :class="tone">
      <Icon :name="tone === 'err' ? 'i-warn' : tone === 'ok' ? 'i-check' : 'i-devices'" :size="13" />
      {{ status }}
    </p>

    <p class="state idle">{{ localLine }}</p>
    <p v-if="backupKey" class="note">覆盖前会自动备份，当前保留最近一份：<code>{{ backupKey }}</code></p>
  </div>
</template>

<style scoped>
.lan {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.addr-box {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  background: var(--field);
}

.addr-label {
  width: 100%;
  font-size: 11.5px;
  color: var(--ink3);
}

.addr {
  flex: 1;
  min-width: 0;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 15px;
  letter-spacing: 0.02em;
  color: var(--accent);
  word-break: break-all;
  user-select: all;
}

.field label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--ink2);
}

.row {
  display: flex;
  gap: 8px;
}

.row input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--field);
  color: var(--ink);
  font-size: 13.5px;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.row input:focus {
  border-color: var(--accent);
  outline: none;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.note {
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--ink3);
}

.note code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--field);
  font-size: 11.5px;
}

.state {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
}

.state svg {
  flex: none;
  margin-top: 2px;
}

.state.ok {
  color: var(--ok, #4caf82);
}

.state.err {
  color: var(--bad, #e8623a);
}

.state.idle {
  color: var(--ink3);
}

@media (max-width: 760px) {
  .row {
    flex-wrap: wrap;
  }

  .row input {
    flex-basis: 100%;
    padding: 12px;
    font-size: 15px; /* 小于 16px 时 iOS 会自动放大页面 */
  }

  .actions .btn {
    flex: 1;
    min-width: 44%;
    justify-content: center;
  }

  .addr {
    font-size: 17px;
  }
}
</style>

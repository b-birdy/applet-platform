<script setup lang="ts">
// 小程序沙箱容器：iframe sandbox（不含同源授权）+ postMessage 握手
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../../api/client';

const route = useRoute();
const appletId = route.params.id as string;
const frame = ref<HTMLIFrameElement | null>(null);
const error = ref('');
const notReady = ref(false);
const fullscreen = ref(false);
let renewTimer: number | undefined;

async function injectToken() {
  try {
    const { token } = await api<{ token: string }>('/api/applet-token', { method: 'POST', body: { appletId } });
    frame.value?.contentWindow?.postMessage({ type: 'applet-token', token }, '*');
  } catch (e: any) {
    error.value = e.code === 'APPLET_FORBIDDEN'
      ? '未获授权访问该应用：请联系管理员在「小程序管理 → 授权」中为你开通，或将应用状态改为「启用」。'
      : '凭据获取失败，请刷新重试。';
    notReady.value = true;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && fullscreen.value) fullscreen.value = false;
}
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await injectToken();
  // 55 分钟续期（token 60 分钟过期，提前 5 分钟）
  renewTimer = window.setInterval(injectToken, 55 * 60 * 1000);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (renewTimer) window.clearInterval(renewTimer);
});

// 全屏 = 平台框架隐藏（本组件以 fixed 覆盖全视口），非浏览器 Fullscreen API——
// 沙箱 iframe 不受影响，Esc 或再次点击开关退出
function toggleFullscreen() {
  fullscreen.value = !fullscreen.value;
}
</script>

<template>
  <div class="frame-wrap" :class="{ fullscreen }">
    <button
      class="fs-toggle"
      :title="fullscreen ? '退出全屏（Esc）' : '全屏显示（隐藏平台框架）'"
      @click="toggleFullscreen"
      @keydown.esc="fullscreen = false"
    >{{ fullscreen ? '⤢ 退出全屏' : '⛶ 全屏' }}</button>
    <div v-if="notReady && !fullscreen" class="guide" role="status">
      <p class="guide-title">小程序尚未就绪</p>
      <p>如果 iframe 区域显示空白或乱码，通常是内容还未合并到平台：</p>
      <ol>
        <li>管理员进入「小程序管理」，找到该应用的行；</li>
        <li>若「PR」列显示待合并，点击「检查报告」确认无 error 后「合并 PR」；</li>
        <li>合并后平台自动同步（几秒内），然后「状态 → 启用」；</li>
        <li>回到本页刷新即可看到应用界面。</li>
      </ol>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <!-- sandbox 不含同源授权：小程序拿不到平台 cookie/任何平台域权限 -->
    <iframe
      ref="frame"
      class="frame"
      :src="`/app/${appletId}/`"
      sandbox="allow-scripts allow-forms allow-popups"
      @load="injectToken"
    ></iframe>
  </div>
</template>

<style scoped>
.frame-wrap { height: calc(100vh - 60px); display: flex; flex-direction: column; position: relative; }
/* 全屏：覆盖整个视口，隐藏平台框架（侧栏/顶部）。fixed 层级压过侧栏 */
.frame-wrap.fullscreen {
  position: fixed; inset: 0; z-index: 100; height: 100vh;
  background: var(--canvas); padding: 0;
}
.fs-toggle {
  position: absolute; top: 10px; right: 14px; z-index: 101;
  border: 1px solid var(--line); border-radius: 8px; padding: 4px 10px;
  background: color-mix(in srgb, var(--panel) 85%, transparent); color: var(--ink-2);
  font-size: 12px; cursor: pointer; backdrop-filter: blur(6px);
  transition: color .12s ease, border-color .12s ease;
}
.fs-toggle:hover { color: var(--accent); border-color: var(--accent); }
.err { color: var(--danger); font-size: 13px; }
.frame { flex: 1; width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.guide {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 16px 20px; margin-bottom: 12px; font-size: 13px; color: var(--ink-2);
}
.guide-title { font-weight: 700; color: var(--ink); margin: 0 0 6px; }
.guide ol { margin: 6px 0 0; padding-left: 20px; }
.guide li { margin: 3px 0; }
</style>

<script setup lang="ts">
// 小程序沙箱容器：iframe sandbox（不含同源授权）+ postMessage 握手
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../../api/client';

const route = useRoute();
const appletId = route.params.id as string;
const frame = ref<HTMLIFrameElement | null>(null);
const error = ref('');
let renewTimer: number | undefined;

async function injectToken() {
  try {
    const { token } = await api<{ token: string }>('/api/applet-token', { method: 'POST', body: { appletId } });
    frame.value?.contentWindow?.postMessage({ type: 'applet-token', token }, '*');
  } catch (e: any) {
    error.value = e.code === 'APPLET_FORBIDDEN' ? '未获授权访问该应用' : '凭据获取失败，请刷新重试';
  }
}

onMounted(async () => {
  await injectToken();
  // 55 分钟续期（token 60 分钟过期，提前 5 分钟）
  renewTimer = window.setInterval(injectToken, 55 * 60 * 1000);
});

onBeforeUnmount(() => {
  if (renewTimer) window.clearInterval(renewTimer);
});
</script>

<template>
  <div class="frame-wrap">
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
.frame-wrap { height: calc(100vh - 60px); display: flex; flex-direction: column; }
.err { color: var(--danger); font-size: 13px; }
.frame { flex: 1; width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
</style>

<script setup lang="ts">
// 顶部路由加载进度条：路由切换即出现（先点亮页面），加载完成消失
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useThemeStore } from './stores/theme';

const theme = useThemeStore();
const progress = ref(0);
let timer: number | undefined;
let visible = false;

const router = useRouter();
onMounted(() => {
  theme.init();
  router.beforeEach(() => {
    // 已有页面在显示（非首屏）才显示进度条；首屏由 index.html 的骨架负责
    visible = true;
    progress.value = 8;
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(() => {
      // 越走越慢、永不到 100（等真正完成时一步到位）
      progress.value = Math.min(progress.value + Math.max(1, (92 - progress.value) * 0.12), 92);
    }, 120);
  });
  router.afterEach(() => finish());
  router.onError(() => finish());
});

function finish() {
  if (!visible) return;
  if (timer) window.clearInterval(timer);
  timer = undefined;
  progress.value = 100;
  // 等动画走完再摘除
  window.setTimeout(() => {
    visible = false;
    progress.value = 0;
  }, 250);
}

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});
</script>

<template>
  <div class="route-progress" :class="{ show: visible }">
    <div class="bar" :style="{ width: progress + '%' }"></div>
  </div>
  <router-view />
</template>

<style scoped>
.route-progress {
  position: fixed; top: 0; left: 0; right: 0; height: 3px;
  z-index: 2000; pointer-events: none; opacity: 0; transition: opacity .2s ease;
}
.route-progress.show { opacity: 1; }
.bar {
  height: 100%; background: var(--accent-grad, var(--accent));
  border-radius: 0 2px 2px 0; box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
  transition: width .2s ease;
}
</style>

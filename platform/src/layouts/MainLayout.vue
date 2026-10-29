<script setup lang="ts">
// 外壳布局：左栏两分区（通用/管理员）+ 可折叠 + 右侧视图
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useThemeStore, THEMES } from '../stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();
const route = useRoute();
const router = useRouter();

const collapsed = ref(window.innerWidth < 768); // 手机窄屏默认折叠
const themePanel = ref(false);
const themeBtn = ref<HTMLElement | null>(null);
// 主题面板：点击面板外任意区域自动收回（按钮与面板自身 .stop 排除，不影响其功能）
function onDocClick() {
  themePanel.value = false;
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
function pickTheme(id: string) {
  theme.setMode(id as any);
  // 同步到账号（与 Profile 页一致），失败静默（未登录等场景本地生效即可）
  fetch('/api/profile', { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: id }) }).catch(() => {});
}
const isMobile = ref(window.innerWidth < 768);
window.addEventListener('resize', () => {
  isMobile.value = window.innerWidth < 768;
  if (isMobile.value) collapsed.value = true;
});

const userItems = [
  { path: '/', label: '首页', icon: '⌂' },
  { path: '/profile', label: '个人信息', icon: '☺' },
  { path: '/my-apps', label: '应用数据', icon: '▦' },
];
const adminItems = [
  { path: '/admin/users', label: '用户管理', icon: '👥' },
  { path: '/admin/applets', label: '小程序管理', icon: '▢' },
  { path: '/admin/agents', label: 'Agent 认证', icon: '⛨' },
  { path: '/admin/settings', label: '系统设置', icon: '⚙' },
  { path: '/admin/logs', label: '操作日志', icon: '☰' },
];

const isAdmin = computed(() => auth.isAdmin);

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  auth.me = null;
  auth.loaded = false;
  router.push('/login');
}
</script>

<template>
  <div class="shell">
    <aside class="side" :class="{ collapsed }">
      <button class="fold" @click="collapsed = !collapsed" :aria-label="collapsed ? '展开菜单' : '折叠菜单'">{{ collapsed ? '»' : '«' }}</button>
      <div class="wordmark" @click="router.push('/')" role="button" tabindex="0">
        <div class="glyph"></div>
        <b v-show="!collapsed">Applet</b>
      </div>

      <nav>
        <div class="sec" v-show="!collapsed">通用</div>
        <router-link v-for="item in userItems" :key="item.path" :to="item.path" class="nav"
          :class="{ on: item.path === '/' ? route.path === '/' : route.path.startsWith(item.path) }"
          @click="isMobile && (collapsed = true)">
          <span class="ico">{{ item.icon }}</span>
          <span v-show="!collapsed">{{ item.label }}</span>
        </router-link>

        <template v-if="isAdmin">
          <div class="sec" v-show="!collapsed">管理员</div>
          <router-link v-for="item in adminItems" :key="item.path" :to="item.path" class="nav"
            :class="{ on: route.path.startsWith(item.path) }">
            <span class="ico">{{ item.icon }}</span>
            <span v-show="!collapsed">{{ item.label }}</span>
          </router-link>
        </template>
      </nav>

      <div class="foot">
        <button ref="themeBtn" class="nav as-btn" :title="'切换主题（当前：' + (THEMES.find((t) => t.id === theme.mode)?.name ?? theme.mode) + '）'" @click.stop="themePanel = !themePanel">
          <span class="ico">🎨</span>
          <span v-show="!collapsed">主题</span>
        </button>
        <div v-if="themePanel" class="theme-panel" @click.stop>
          <button
            v-for="t in THEMES"
            :key="t.id"
            type="button"
            class="theme-item"
            :class="{ on: theme.mode === t.id }"
            @click="pickTheme(t.id)"
          >
            <span class="sw" :style="{ background: t.swatch }"></span>
            <span>{{ t.name }}</span>
            <span v-if="theme.mode === t.id" class="tick">✓</span>
          </button>
        </div>
        <button class="nav as-btn" @click="logout" title="退出登录">
          <span class="ico">⎋</span>
          <span v-show="!collapsed">退出 ({{ auth.me?.username }})</span>
        </button>
      </div>
    </aside>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100%; }
.side {
  position: relative;
  width: 200px; flex: none; display: flex; flex-direction: column;
  background: var(--panel); border-right: 1px solid var(--line); padding: 14px 10px;
  transition: width .18s cubic-bezier(.4, 0, .2, 1);
}
.side.collapsed { width: 48px; padding: 14px 6px; }
@media (max-width: 767px) {
  .side { position: fixed; z-index: 90; height: 100dvh; box-shadow: var(--shadow-lg); }
  .side.collapsed { transform: translateX(-100%); box-shadow: none; }
  .main { padding: 12px !important; }
}
.wordmark { padding: 4px 8px 16px; cursor: pointer; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
.wordmark .glyph { background: var(--accent-grad); box-shadow: 0 2px 6px -2px color-mix(in srgb, var(--accent) 50%, transparent); }
nav { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.sec { font-size: 11px; color: var(--ink-3); padding: 10px 8px 4px; }
.nav {
  display: flex; align-items: center; gap: 9px; padding: 7px 8px; border-radius: 6px;
  color: var(--ink-2); font-size: 13px; text-decoration: none; white-space: nowrap;
  border: none; background: none; font-family: inherit; cursor: pointer; text-align: left;
}
.nav { transition: background .12s ease, color .12s ease; }
.nav:hover { background: var(--accent-soft); color: var(--ink); }
.nav.on { background: linear-gradient(135deg, var(--accent-weak), color-mix(in srgb, var(--accent) 16%, var(--panel))); color: var(--accent); font-weight: 600; box-shadow: inset 2.5px 0 0 var(--accent); border-radius: 6px 10px 10px 6px; }
.side { background: linear-gradient(180deg, var(--surface-2), var(--panel) 120px); }
.ico { width: 16px; text-align: center; flex: none; }
.foot { border-top: 1px solid var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 2px; position: relative; }
.theme-panel {
  position: absolute; bottom: calc(100% + 8px); left: 8px; right: 8px; z-index: 20;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow-lg); padding: 6px;
}
.theme-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  border: none; background: none; font: inherit; font-size: 13px; color: var(--ink-2);
  padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left;
}
.theme-item:hover { background: var(--accent-soft); }
.theme-item.on { color: var(--accent); font-weight: 600; }
.theme-item .sw { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(0,0,0,.1); flex: none; }
.theme-item .tick { margin-left: auto; }
.as-btn { width: 100%; }
.fold {
  position: absolute; left: 100%; top: 50%; transform: translateY(-50%);
  width: 18px; height: 44px; border: 1px solid var(--line);
  background: var(--panel); color: var(--ink-3); cursor: pointer; z-index: 10;
  border-radius: 0 8px 8px 0; box-shadow: var(--shadow-sm);
  transition: color .12s ease;
}
.fold:hover { color: var(--accent); }
.main { flex: 1; min-width: 0; overflow: auto; padding: 18px 22px; }
</style>

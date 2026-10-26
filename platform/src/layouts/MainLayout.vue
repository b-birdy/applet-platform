<script setup lang="ts">
// 外壳布局：左栏两分区（通用/管理员）+ 可折叠 + 右侧视图
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();
const route = useRoute();
const router = useRouter();

const collapsed = ref(false);

const userItems = [
  { path: '/', label: '首页', icon: '⌂' },
  { path: '/profile', label: '个人信息', icon: '☺' },
  { path: '/my-apps', label: '我的应用', icon: '▦' },
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
      <div class="wordmark" @click="router.push('/')" role="button" tabindex="0">
        <div class="glyph"></div>
        <b v-show="!collapsed">Applet</b>
      </div>

      <nav>
        <div class="sec" v-show="!collapsed">通用</div>
        <router-link v-for="item in userItems" :key="item.path" :to="item.path" class="nav"
          :class="{ on: item.path === '/' ? route.path === '/' : route.path.startsWith(item.path) }">
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
        <button class="nav as-btn" @click="theme.setMode(theme.mode === 'dark' ? 'light' : 'dark')" :title="theme.mode === 'dark' ? '切浅色' : '切深色'">
          <span class="ico">{{ theme.mode === 'dark' ? '☀' : '☾' }}</span>
        </button>
        <button class="nav as-btn" @click="logout" title="退出登录">
          <span class="ico">⎋</span>
          <span v-show="!collapsed">退出 ({{ auth.me?.username }})</span>
        </button>
      </div>
    </aside>
    <button class="fold" @click="collapsed = !collapsed" :aria-label="collapsed ? '展开菜单' : '折叠菜单'">{{ collapsed ? '»' : '«' }}</button>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100%; }
.side {
  width: 200px; flex: none; display: flex; flex-direction: column;
  background: var(--panel); border-right: 1px solid var(--line); padding: 14px 10px;
  transition: width .18s cubic-bezier(.4, 0, .2, 1);
}
.side.collapsed { width: 48px; padding: 14px 6px; }
.wordmark { padding: 4px 8px 16px; cursor: pointer; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
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
.ico { width: 16px; text-align: center; flex: none; }
.foot { border-top: 1px solid var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.as-btn { width: 100%; }
.fold {
  position: fixed; left: var(--fold-x, 200px); top: 50%; transform: translateY(-50%);
  width: 18px; height: 44px; border: 1px solid var(--line); border-left: none;
  background: var(--panel); color: var(--ink-3); cursor: pointer; z-index: 10;
  border-radius: 0 8px 8px 0; box-shadow: var(--shadow-sm);
  transition: left .18s cubic-bezier(.4, 0, .2, 1), color .12s ease;
}
.fold:hover { color: var(--accent); }
.main { flex: 1; min-width: 0; overflow: auto; padding: 18px 22px; }
</style>

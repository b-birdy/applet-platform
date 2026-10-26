<script setup lang="ts">
// 首页：问候 + 可用应用宫格（admin 加状态灯与新增格）
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';

type Applet = { id: number; name: string; path: string; icon: string | null; status: string };

const auth = useAuthStore();
const router = useRouter();
const applets = ref<Applet[]>([]);
const loading = ref(true);

const statusLabel: Record<string, string> = { testing: '测试', enabled: '启用', disabled: '停用' };
const statusClass: Record<string, string> = { testing: 'warn', enabled: 'ok', disabled: 'off' };

const greeting = computed(() => {
  const h = new Date().getHours();
  const word = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
  return `${word}，${auth.me?.username}`;
});

onMounted(async () => {
  const res = await api<{ applets: Applet[] }>('/api/my/applets');
  applets.value = res.applets;
  loading.value = false;
});

function open(a: Applet) {
  // admin 可预览 testing/disabled（iframe 路径由 worker 鉴权），普通用户仅 enabled
  if (auth.isAdmin || a.status === 'enabled') router.push(`/app/${a.path}`);
}
</script>

<template>
  <div>
    <header class="head">
      <h1>{{ greeting }}</h1>
      <span class="who">{{ auth.isAdmin ? '管理员' : '用户' }} · {{ applets.length }} 个可用应用</span>
    </header>

    <p v-if="loading" class="empty">加载中…</p>
    <p v-else-if="applets.length === 0" class="empty">还没有可用的小程序。管理员可在「小程序管理」中添加。</p>

    <div v-else class="tiles">
      <button v-for="a in applets" :key="a.id" class="tile" :class="{ dim: a.status !== 'enabled' }" @click="open(a)">
        <span class="ic">{{ a.icon || '▣' }}</span>
        <b>{{ a.name }}</b>
        <span v-if="auth.isAdmin" class="st" :class="statusClass[a.status]"><i></i>{{ statusLabel[a.status] }}</span>
      </button>
      <button v-if="auth.isAdmin" class="tile add" @click="router.push('/admin/applets')">
        <span class="ic plus">＋</span>
        <b>新增</b>
      </button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
h1 { font-size: 17px; margin: 0; }
.who { font-size: 12px; color: var(--ink-3); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 12px; max-width: 640px; }
.tile {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 16px 10px 12px; cursor: pointer; font: inherit; color: inherit;
}
.tile:hover { border-color: var(--accent); }
.tile.dim { opacity: .55; }
.ic { width: 44px; height: 44px; border-radius: 11px; background: var(--accent-weak); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; }
.tile.add { border-style: dashed; background: transparent; }
.ic.plus { background: transparent; border: 1.5px dashed var(--line-strong); color: var(--ink-3); font-size: 18px; }
.tile b { font-size: 13px; font-weight: 600; }
.empty { color: var(--ink-3); margin-top: 40px; text-align: center; }
</style>

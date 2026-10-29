<script setup lang="ts">
// 首页：问候 + 可用应用宫格（admin 加状态灯与新增格）
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';

type Applet = { id: number; name: string; path: string; icon: string | null; status: string };
function iconIsImg(icon: string | null): boolean {
  return !!icon && icon.startsWith('data:image');
}

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
  if (!(auth.isAdmin || a.status === 'enabled')) return;
  // 使用统计打点（失败静默）
  fetch('/api/my/applet-open', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appletId: a.path }) }).catch(() => {});
  if ((a as any).display === 'new_tab') {
    // 新标签页：仍然走平台的 /app/ 路径（鉴权+token 注入逻辑相同）
    window.open(`/app/${a.path}/`, '_blank');
  } else {
    router.push(`/app/${a.path}`);
  }
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
        <img v-if="iconIsImg(a.icon)" class="ic img" :src="a.icon!" alt="">
        <span v-else class="ic">{{ a.icon || '▣' }}</span>
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
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 14px; max-width: 720px; }
.tile {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-md);
  padding: 18px 10px 14px; cursor: pointer; font: inherit; color: inherit;
  box-shadow: var(--shadow-sm); transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
}
.tile:hover { transform: translateY(-3px); box-shadow: var(--shadow-md); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.tile:active { transform: translateY(-1px); }
.tile.dim { opacity: .55; }
.ic {
  width: 56px; height: 56px; border-radius: 15px; color: var(--accent);
  background: linear-gradient(135deg, var(--accent-weak), color-mix(in srgb, var(--accent) 14%, var(--panel)));
  display: flex; align-items: center; justify-content: center; font-size: 27px;
  transition: transform .15s ease, box-shadow .15s ease;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25);
}
.ic.img { object-fit: cover; background: var(--surface-2); }
.tile:hover .ic { transform: scale(1.08) translateY(-1px); box-shadow: 0 6px 16px -4px color-mix(in srgb, var(--accent) 35%, transparent); }
.tile.add { border-style: dashed; background: transparent; box-shadow: none; }
.tile.add:hover { transform: translateY(-3px); border-color: var(--accent); }
.ic.plus { background: transparent; border: 1.5px dashed var(--line-strong); color: var(--ink-3); font-size: 18px; }
.tile b { font-size: 13px; font-weight: 600; }
.empty { color: var(--ink-3); margin-top: 40px; text-align: center; }
</style>

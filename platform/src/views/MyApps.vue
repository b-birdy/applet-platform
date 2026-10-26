<script setup lang="ts">
// 我的应用：用量列表 + 导出 + 清除（确认弹窗）
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/client';

type Usage = { appletId: string; rows: number; lastActivity: string | null };

const usage = ref<Usage[]>([]);
const loading = ref(true);

async function load() {
  const res = await api<{ applets: Usage[] }>('/api/my/usage');
  usage.value = res.applets;
  loading.value = false;
}
onMounted(load);

async function exportData(appletId: string) {
  // 附件下载：直接开地址（cookie 同源携带）
  window.location.href = `/api/my/export?applet=${encodeURIComponent(appletId)}`;
}

async function purge(a: Usage) {
  try {
    await ElMessageBox.confirm(
      `将永久删除你在「${a.appletId}」的全部 ${a.rows} 行数据，且不可恢复。确定继续吗？`,
      '清除我的数据',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
  } catch {
    return;
  }
  try {
    const res = await api<{ deleted: number }>(`/api/my/purge?applet=${encodeURIComponent(a.appletId)}`, { method: 'POST' });
    ElMessage.success(`已清除 ${res.deleted} 行`);
    await load();
  } catch {
    ElMessage.error('清除失败');
  }
}
</script>

<template>
  <div>
    <header class="head"><h1>我的应用</h1></header>
    <p v-if="loading">加载中…</p>
    <el-empty v-else-if="usage.length === 0" description="还没有使用中的应用" />
    <ul v-else class="list">
      <li v-for="a in usage" :key="a.appletId">
        <div class="info">
          <b>{{ a.appletId }}</b>
          <span class="meta">{{ a.rows }} 行数据<template v-if="a.lastActivity"> · 最近使用 {{ a.lastActivity }}</template></span>
        </div>
        <div class="ops">
          <el-tooltip content="把你在该应用中的全部数据下载为 JSON 文件" placement="top">
            <el-button size="small" :disabled="a.rows === 0" @click="exportData(a.appletId)">导出 JSON</el-button>
          </el-tooltip>
          <el-tooltip content="永久删除你在该应用中的全部数据，不可恢复" placement="top">
            <el-button size="small" type="danger" plain :disabled="a.rows === 0" @click="purge(a)">清除数据</el-button>
          </el-tooltip>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.head h1 { font-size: 17px; margin: 0 0 14px; }
.list { list-style: none; margin: 0; padding: 0; max-width: 720px; }
.list li {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 16px; margin-bottom: 10px;
}
.info b { font-size: 14px; }
.meta { display: block; font-size: 12px; color: var(--ink-3); }
.ops { display: flex; gap: 8px; }
</style>

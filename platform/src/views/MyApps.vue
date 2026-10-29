<script setup lang="ts">
// 应用数据（原「我的应用」）：表预览（名称/说明/我的行数）+ 导出 + 清除（确认弹窗）
// 只展示数据表的元信息与行数，不提供数据详情查看，防风险
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/client';

type Usage = { appletId: string; rows: number; lastActivity: string | null };
type TableInfo = { name: string; description: string; rows: number };

const usage = ref<Usage[]>([]);
const loading = ref(true);

// 表预览抽屉状态
const tblVisible = ref(false);
const tblTarget = ref<Usage | null>(null);
const tables = ref<TableInfo[]>([]);
const tblLoading = ref(false);

async function load() {
  const res = await api<{ applets: Usage[] }>('/api/my/usage');
  usage.value = res.applets;
  loading.value = false;
}
onMounted(load);

async function openTables(a: Usage) {
  tblTarget.value = a;
  tblVisible.value = true;
  tblLoading.value = true;
  tables.value = [];
  try {
    const res = await api<{ tables: TableInfo[] }>(`/api/my/tables/${encodeURIComponent(a.appletId)}`);
    tables.value = res.tables;
  } catch {
    ElMessage.error('数据表信息加载失败');
  }
  tblLoading.value = false;
}

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
    tblVisible.value = false;
    await load();
  } catch {
    ElMessage.error('清除失败');
  }
}
</script>

<template>
  <div>
    <header class="head"><h1>应用数据</h1></header>
    <p v-if="loading">加载中…</p>
    <el-empty v-else-if="usage.length === 0" description="还没有使用中的应用" />
    <ul v-else class="list">
      <li v-for="a in usage" :key="a.appletId">
        <div class="info">
          <b>{{ a.appletId }}</b>
          <span class="meta">{{ a.rows }} 行数据<template v-if="a.lastActivity"> · 最近使用 {{ a.lastActivity }}</template></span>
        </div>
        <div class="ops">
          <el-tooltip content="查看该应用包含哪些数据表、各表的用途与你的数据行数（不含数据内容）" placement="top">
            <el-button size="small" @click="openTables(a)">数据预览</el-button>
          </el-tooltip>
          <el-tooltip content="把你在该应用中的全部数据下载为 JSON 文件" placement="top">
            <el-button size="small" :disabled="a.rows === 0" @click="exportData(a.appletId)">导出 JSON</el-button>
          </el-tooltip>
          <el-tooltip content="永久删除你在该应用中的全部数据，不可恢复" placement="top">
            <el-button size="small" type="danger" plain :disabled="a.rows === 0" @click="purge(a)">清除数据</el-button>
          </el-tooltip>
        </div>
      </li>
    </ul>

    <!-- 数据表预览抽屉 -->
    <el-drawer v-model="tblVisible" :title="`数据表 — ${tblTarget?.appletId}`" size="480px">
      <p class="hint" style="margin: 0 0 12px">仅展示表结构与你的数据行数；出于安全考虑，此处不提供数据内容查看。</p>
      <div v-loading="tblLoading">
        <el-empty v-if="!tblLoading && tables.length === 0" description="该应用没有声明数据表" :image-size="60" />
        <div v-for="t in tables" :key="t.name" class="tbl-card">
          <div class="tbl-top">
            <b class="mono">{{ t.name }}</b>
            <span class="tbl-rows">{{ t.rows }} 行</span>
          </div>
          <p class="tbl-desc">{{ t.description }}</p>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.head h1 { font-size: 17px; margin: 0 0 14px; }
.list { list-style: none; margin: 0; padding: 0; max-width: 780px; }
.list li {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 16px; margin-bottom: 10px;
}
.info b { font-size: 14px; }
.meta { display: block; font-size: 12px; color: var(--ink-3); }
.ops { display: flex; gap: 8px; flex-wrap: wrap; }
.mono { font-family: ui-monospace, monospace; font-size: 13px; }
.tbl-card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; }
.tbl-top { display: flex; align-items: center; justify-content: space-between; }
.tbl-rows { font-size: 12px; color: var(--ink-3); }
.tbl-desc { font-size: 12px; color: var(--ink-2); margin: 6px 0 0; line-height: 1.6; }
</style>

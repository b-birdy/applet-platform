<script setup lang="ts">
// 系统设置：站点参数 + GitHub 连接状态 + 手动同步
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api, ApiError } from '../../api/client';

const settings = ref<Record<string, string>>({
  site_name: '', registration_enabled: '0', lock_threshold: '5', lock_minutes: '10', quota_rows: '10000', quota_bytes: '20971520',
});
const github = ref<{ configured: boolean; lastSync: string | null }>({ configured: false, lastSync: null });
const syncing = ref(false);

async function load() {
  const res = await api<any>('/api/admin/settings');
  settings.value = { ...settings.value, ...res.settings };
  github.value = res.github;
}
onMounted(load);

async function save() {
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: {
        site_name: settings.value.site_name,
        lock_threshold: String(Number(settings.value.lock_threshold)),
        lock_minutes: String(Number(settings.value.lock_minutes)),
        quota_rows: String(Number(settings.value.quota_rows)),
        quota_bytes: String(Number(settings.value.quota_bytes)),
      },
    });
    ElMessage.success('设置已保存');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '保存失败');
  }
}

async function syncNow() {
  syncing.value = true;
  try {
    const res = await api<{ added: string[]; missing: string[] }>('/api/admin/sync', { method: 'POST' });
    ElMessage.success(`同步完成：新增 ${res.added.length}，缺失 ${res.missing.length}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? '同步失败（检查 GitHub 配置）' : '同步失败');
  } finally {
    syncing.value = false;
  }
}
</script>

<template>
  <div class="grid">
    <section class="card">
      <h2>平台参数</h2>
      <el-form label-width="150px" @submit.prevent>
        <el-form-item label="站点名">
          <el-input v-model="settings.site_name" />
        </el-form-item>
        <el-form-item label="开放注册">
          <el-switch v-model="settings.registration_enabled" active-value="1" inactive-value="0" disabled />
          <span class="hint">（v0.1 预留，仅管理员建号）</span>
        </el-form-item>
        <el-form-item label="登录失败锁定阈值">
          <el-input-number v-model="settings.lock_threshold" :min="3" :max="20" />
          <span class="hint">次</span>
        </el-form-item>
        <el-form-item label="锁定时长">
          <el-input-number v-model="settings.lock_minutes" :min="5" :max="1440" />
          <span class="hint">分钟</span>
        </el-form-item>
        <el-form-item label="每用户行数配额">
          <el-input-number v-model="settings.quota_rows" :min="100" :max="100000" :step="1000" />
        </el-form-item>
        <el-form-item label="每用户字节配额">
          <el-input-number v-model="settings.quota_bytes" :min="1048576" :max="104857600" :step="1048576" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="save">保存设置</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="card">
      <h2>GitHub 连接</h2>
      <p>
        <span class="st" :class="github.configured ? 'ok' : 'off'"><i></i>{{ github.configured ? '已配置' : '未配置（缺 GITHUB_TOKEN 等 Secrets）' }}</span>
      </p>
      <p class="hint">最近同步：{{ github.lastSync ?? '从未' }}</p>
      <p class="hint">平台每 5 分钟自动同步 main 分支；PR 合并后立即同步。也可手动触发：</p>
      <el-button :loading="syncing" @click="syncNow">立即同步</el-button>
    </section>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; max-width: 960px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
h2 { font-size: 14px; margin: 0 0 12px; }
.hint { font-size: 12px; color: var(--ink-3); margin-left: 8px; }
</style>

<script setup lang="ts">
// 个人信息：改昵称/改密码/登录历史/主题切换（D33）
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();

const nickname = ref('');
const oldPassword = ref('');
const newPassword = ref('');
const history = ref<{ action: string; at: string }[]>([]);

onMounted(async () => {
  const me = await api<any>('/api/me');
  nickname.value = (me as any).username; // nickname 后端暂未下发到 /api/me，先显示用户名
  try {
    const h = await api<{ rows: { action: string; at: string }[] }>('/api/my/logins');
    history.value = h.rows;
  } catch { /* 登录历史接口在 profile 区块，允许失败为空 */ }
});

async function saveNickname() {
  try {
    await api('/api/profile', { method: 'PUT', body: { nickname: nickname.value } });
    ElMessage.success('昵称已保存');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.code : '保存失败');
  }
}

async function changePassword() {
  if (!oldPassword.value || !newPassword.value) {
    ElMessage.warning('请填写旧密码与新密码');
    return;
  }
  try {
    await api('/api/profile/password', { method: 'POST', body: { oldPassword: oldPassword.value, newPassword: newPassword.value } });
    oldPassword.value = '';
    newPassword.value = '';
    ElMessage.success('密码已修改');
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? (e.code === 'WRONG_PASSWORD' ? '旧密码不正确' : e.code) : '修改失败');
  }
}

async function toggleTheme(mode: 'light' | 'dark') {
  theme.setMode(mode);
  try {
    await api('/api/profile', { method: 'PUT', body: { theme: mode } });
  } catch { /* 主题偏好存档失败不阻断本地切换 */ }
}
</script>

<template>
  <div class="grid">
    <section class="card">
      <h2>基本信息</h2>
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="用户名">
          <el-input :model-value="auth.me?.username" disabled />
        </el-form-item>
        <el-form-item label="角色">
          <el-tag :type="auth.isAdmin ? 'warning' : 'info'">{{ auth.isAdmin ? '管理员' : '普通用户' }}</el-tag>
        </el-form-item>
        <el-form-item label="昵称">
          <div class="row">
            <el-input v-model="nickname" />
            <el-button type="primary" @click="saveNickname">保存</el-button>
          </div>
        </el-form-item>
      </el-form>
    </section>

    <section class="card">
      <h2>修改密码</h2>
      <el-form label-width="80px" @submit.prevent>
        <el-form-item label="旧密码">
          <el-input v-model="oldPassword" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="newPassword" type="password" show-password />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="changePassword">修改密码</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section class="card">
      <h2>外观</h2>
      <el-radio-group :model-value="theme.mode" @update:model-value="toggleTheme($event as any)">
        <el-radio-button value="light">浅色</el-radio-button>
        <el-radio-button value="dark">深色</el-radio-button>
      </el-radio-group>
    </section>

    <section class="card">
      <h2>登录历史</h2>
      <el-empty v-if="history.length === 0" description="暂无记录" :image-size="60" />
      <ul v-else class="history">
        <li v-for="(h, i) in history" :key="i">
          <span class="st" :class="h.action === 'login.success' ? 'ok' : 'off'"><i></i>{{ h.action }}</span>
          <span class="at">{{ h.at }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; max-width: 900px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
h2 { font-size: 14px; margin: 0 0 12px; }
.row { display: flex; gap: 8px; }
.history { list-style: none; margin: 0; padding: 0; }
.history li { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.history .at { color: var(--ink-3); }
</style>

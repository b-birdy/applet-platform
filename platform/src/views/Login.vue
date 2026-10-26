<script setup lang="ts">
// 登录页：方格底纹 + 居中白卡（D20）
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      error.value = json.code === 'LOCKED' ? '已锁定，请稍后再试或联系管理员' : '用户名或密码错误';
      return;
    }
    await auth.fetchMe();
    router.push((route.query.redirect as string) || '/');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="grid-bg" aria-hidden="true"></div>
    <form class="card" @submit.prevent="submit">
      <div class="wordmark"><div class="glyph"></div><b>Applet 平台</b></div>
      <label>
        <span>用户名</span>
        <input v-model="username" name="username" autocomplete="username" required>
      </label>
      <label>
        <span>密码</span>
        <input v-model="password" name="password" type="password" autocomplete="current-password" required>
      </label>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <button class="btn" type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
      <p class="foot">个人应用平台 · 仅限授权用户</p>
    </form>
  </div>
</template>

<style scoped>
.page { position: relative; height: 100%; display: flex; align-items: center; justify-content: center; }
.grid-bg { position: absolute; inset: 0; }
.card {
  position: relative; width: 320px; background: var(--panel);
  border: 1px solid var(--line-strong); border-radius: 10px; padding: 28px 26px;
  box-shadow: 0 1px 2px rgba(28, 36, 34, .05);
}
.wordmark { margin-bottom: 20px; }
label { display: block; margin-bottom: 12px; }
label span { display: block; font-size: 12px; color: var(--ink-2); margin-bottom: 4px; }
input {
  width: 100%; height: 34px; border: 1px solid var(--line-strong); border-radius: 6px;
  padding: 0 10px; font: inherit; font-size: 13px; color: var(--ink);
  background: var(--panel); outline: none;
}
input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
.err { color: var(--danger); font-size: 12px; margin: 0 0 10px; }
.btn {
  width: 100%; height: 34px; border-radius: 6px; border: 1px solid var(--accent);
  background: var(--accent); color: #fff; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.btn:disabled { opacity: .6; cursor: default; }
.foot { margin: 14px 0 0; font-size: 12px; color: var(--ink-3); text-align: center; }
</style>

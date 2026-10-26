// 会话状态：/api/me 拉取当前用户
import { defineStore } from 'pinia';
import { api } from '../api/client';

export type Me = { userId: number; role: string; username: string };

export const useAuthStore = defineStore('auth', {
  state: () => ({ me: null as Me | null, loaded: false }),
  getters: {
    isAdmin: (s) => s.me?.role === 'admin' || s.me?.role === 'superadmin',
  },
  actions: {
    async fetchMe() {
      try {
        this.me = await api<Me>('/api/me');
      } catch {
        this.me = null;
      }
      this.loaded = true;
      return this.me;
    },
  },
});

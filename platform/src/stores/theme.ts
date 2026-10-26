// 主题：浅/深双主题（D33），持久化到 localStorage
import { defineStore } from 'pinia';

type Mode = 'light' | 'dark';

const KEY = 'applet-theme';

export const useThemeStore = defineStore('theme', {
  state: () => ({ mode: 'light' as Mode }),
  actions: {
    init() {
      const saved = localStorage.getItem(KEY) as Mode | null;
      if (saved === 'dark' || saved === 'light') this.setMode(saved);
    },
    setMode(mode: Mode) {
      this.mode = mode;
      localStorage.setItem(KEY, mode);
      // Element Plus 暗色模式与平台变量共用 html.dark 开关
      document.documentElement.classList.toggle('dark', mode === 'dark');
    },
  },
});

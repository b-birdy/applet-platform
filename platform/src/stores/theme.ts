// 主题：6 风格主题（工板 2.0），每主题通过 html[data-theme] 切换变量集
// 深色系主题同时挂 html.dark 供 Element Plus 暗色模式使用
import { defineStore } from 'pinia';

export type ThemeId = 'light' | 'dark' | 'minimal' | 'neon' | 'glass' | 'classic';

export const THEMES: { id: ThemeId; name: string; dark: boolean; swatch: string }[] = [
  { id: 'light', name: '清新文艺', dark: false, swatch: '#F6F7F5' },
  { id: 'dark', name: '暗黑模式', dark: true, swatch: '#0F1513' },
  { id: 'minimal', name: '极简主义', dark: false, swatch: '#FAFAFA' },
  { id: 'neon', name: '霓虹渐变', dark: true, swatch: '#12102A' },
  { id: 'glass', name: '玻璃拟态', dark: true, swatch: '#141E2C' },
  { id: 'classic', name: '复古高雅', dark: false, swatch: '#F5F0E6' },
];

const KEY = 'applet-theme';
const VALID = new Set(THEMES.map((t) => t.id));

export const useThemeStore = defineStore('theme', {
  state: () => ({ mode: 'light' as ThemeId }),
  actions: {
    init() {
      const saved = localStorage.getItem(KEY) as ThemeId | null;
      // 无保存值时也应用默认主题（data-theme 需在首帧就位，避免闪变）
      this.setMode(saved && VALID.has(saved) ? saved : 'light');
    },
    setMode(mode: ThemeId) {
      if (!VALID.has(mode)) return; // 非法主题拒绝（localStorage 被篡改等场景）
      this.mode = mode;
      localStorage.setItem(KEY, mode);
      const root = document.documentElement;
      root.setAttribute('data-theme', mode);
      // Element Plus 暗色模式跟随深色系主题
      const isDark = THEMES.find((t) => t.id === mode)?.dark ?? false;
      root.classList.toggle('dark', isDark);
    },
  },
});

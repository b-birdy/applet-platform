import { describe, expect, it, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useThemeStore, THEMES } from './theme';

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('theme store', () => {
  it('defaults to light (init applies DOM state)', () => {
    const theme = useThemeStore();
    theme.init(); // App.vue onMounted 同款调用
    expect(theme.mode).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('dark theme sets html.dark + data-theme and persists', () => {
    const theme = useThemeStore();
    theme.setMode('dark');
    expect(theme.mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('applet-theme')).toBe('dark');
  });

  it('six themes defined; dark-family toggles html.dark, light-family does not', () => {
    expect(THEMES).toHaveLength(6);
    const theme = useThemeStore();
    for (const t of THEMES) {
      theme.setMode(t.id);
      expect(theme.mode).toBe(t.id);
      expect(document.documentElement.getAttribute('data-theme')).toBe(t.id);
      expect(document.documentElement.classList.contains('dark')).toBe(t.dark);
    }
  });

  it('rejects unknown theme ids (falls back gracefully, no DOM change)', () => {
    const theme = useThemeStore();
    // @ts-expect-error 故意传非法值验证防御
    theme.setMode('hacker-theme');
    expect(localStorage.getItem('applet-theme')).not.toBe('hacker-theme');
  });

  it('initializes from localStorage', () => {
    localStorage.setItem('applet-theme', 'neon');
    const theme = useThemeStore();
    theme.init();
    expect(theme.mode).toBe('neon');
    expect(document.documentElement.getAttribute('data-theme')).toBe('neon');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

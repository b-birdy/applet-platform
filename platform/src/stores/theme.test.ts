import { describe, expect, it, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useThemeStore } from './theme';

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('theme store', () => {
  it('defaults to light', () => {
    const theme = useThemeStore();
    expect(theme.mode).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggling to dark sets html.dark and persists', () => {
    const theme = useThemeStore();
    theme.setMode('dark');
    expect(theme.mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('applet-theme')).toBe('dark');
  });

  it('toggling back to light removes class and persists', () => {
    const theme = useThemeStore();
    theme.setMode('dark');
    theme.setMode('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('applet-theme')).toBe('light');
  });

  it('initializes from localStorage', () => {
    localStorage.setItem('applet-theme', 'dark');
    const theme = useThemeStore();
    theme.init();
    expect(theme.mode).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

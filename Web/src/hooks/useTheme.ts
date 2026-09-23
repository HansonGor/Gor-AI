// 主题管理 Hook
// 负责暗黑/白天模式切换，状态持久化到本地存储
import { useState, useCallback } from 'react';
import { STORAGE_KEYS, THEME_CONFIG } from '../config';
import type { ThemeType } from '../types';

const { THEME } = STORAGE_KEYS;
const { DARK, LIGHT, DEFAULT } = THEME_CONFIG as { DARK: ThemeType; LIGHT: ThemeType; DEFAULT: ThemeType };

export function useTheme() {
  // 主题状态：dark 暗黑模式，light 白天模式，默认暗黑
  const [theme, setTheme] = useState<ThemeType>(() => {
    try {
      const saved = localStorage.getItem(THEME);
      return saved === LIGHT ? LIGHT : DARK;
    } catch {
      return DEFAULT as ThemeType;
    }
  });

  /**
   * 切换主题
   */
  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === DARK ? LIGHT : DARK;
      try {
        localStorage.setItem(THEME, next);
      } catch {
        // 忽略存储错误
      }
      return next;
    });
  }, []);

  /**
   * 设置主题
   */
  const setThemeValue = useCallback((newTheme: ThemeType) => {
    if (newTheme !== DARK && newTheme !== LIGHT) return;
    setTheme(newTheme);
    try {
      localStorage.setItem(THEME, newTheme);
    } catch {
      // 忽略存储错误
    }
  }, []);

  return {
    theme,
    toggleTheme,
    setTheme: setThemeValue,
    isDark: theme === DARK,
    isLight: theme === LIGHT,
  };
}

export default useTheme;

// 布局管理 Hook
// 负责 PC/移动端布局判断、侧边栏展开/折叠状态管理
import { useState, useEffect, useCallback } from 'react';
import { LAYOUT_CONFIG, STORAGE_KEYS } from '../config';

const { PC_BREAKPOINT } = LAYOUT_CONFIG;
const { SIDEBAR_OPEN } = STORAGE_KEYS;

export function useLayout() {
  // 布局模式：isPC = true 为 PC 双栏，false 为手机/平板悬浮侧边栏
  const [isPC, setIsPC] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= PC_BREAKPOINT;
    }
    return true;
  });

  // PC 模式侧边栏展开状态（仅 PC 模式使用，读取本地存储）
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_OPEN);
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  // 移动端侧边栏悬浮显示状态
  const [mobileSidebarVisible, setMobileSidebarVisible] = useState(false);

  /**
   * 监听窗口宽度变化，自动切换布局模式
   */
  useEffect(() => {
    const handleResize = () => {
      const nowIsPC = window.innerWidth >= PC_BREAKPOINT;
      setIsPC((prev) => {
        if (prev !== nowIsPC) {
          // 布局模式切换瞬间，重置侧边栏状态
          if (nowIsPC) {
            // 切 PC：读取本地缓存
            try {
              const saved = localStorage.getItem(SIDEBAR_OPEN);
              setSidebarOpen(saved !== null ? saved === 'true' : true);
            } catch {
              setSidebarOpen(true);
            }
          } else {
            // 切手机/平板：强制关闭侧边栏
            setMobileSidebarVisible(false);
          }
        }
        return nowIsPC;
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /**
   * PC 模式：切换侧边栏展开/折叠，写入本地存储
   */
  const togglePCSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_OPEN, String(next));
      } catch {
        // 忽略存储错误
      }
      return next;
    });
  }, []);

  /**
   * 移动端：打开悬浮侧边栏
   */
  const openMobileSidebar = useCallback(() => {
    setMobileSidebarVisible(true);
  }, []);

  /**
   * 移动端：关闭悬浮侧边栏
   */
  const closeMobileSidebar = useCallback(() => {
    setMobileSidebarVisible(false);
  }, []);

  return {
    // 布局状态
    isPC,
    sidebarOpen,
    mobileSidebarVisible,
    // 布局方法
    togglePCSidebar,
    openMobileSidebar,
    closeMobileSidebar,
  };
}

export default useLayout;

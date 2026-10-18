import { useEffect, type RefObject } from 'react';

/** 弹框打开时：点击容器外关闭；Esc 关闭并把焦点还给触发按钮。 */
export function usePopoverDismiss(open: boolean, close: () => void,
  container: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close, container, trigger]);
}

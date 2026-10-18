import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { extractShareMessages, isShareableMessage } from './shareContent';
import { disposeShareImage, exportShareImage, type ShareImage } from './exportShareImage';
import { getUserNickname } from '../user/profile';

/** Session-owned sharing state. Export freezes a narrow body snapshot, not Agent state. */
export function useChatShare(sessionId: string | null, messages: ChatMessage[]) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [image, setImage] = useState<ShareImage | null>(null);
  const ownedImage = useRef<ShareImage | null>(null);
  const job = useRef<AbortController | null>(null);
  const clearPreview = () => {
    job.current?.abort();
    job.current = null;
    disposeShareImage(ownedImage.current);
    ownedImage.current = null;
    setImage(null);
    setBusy(false);
    setOpen(false);
    setError('');
  };
  const cancel = () => {
    clearPreview();
    setSelecting(false);
    setSelectedIds(new Set());
  };
  useEffect(() => {
    cancel();
    return () => {
      job.current?.abort();
      disposeShareImage(ownedImage.current);
    };
  }, [sessionId]);
  const selected = extractShareMessages(messages, selectedIds);
  const toggle = (id: string) => {
    if (!messages.some((message) => message.id === id && isShareableMessage(message))) return;
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearAll = () => setSelectedIds(new Set());
  const generate = async () => {
    if (!selected.length || job.current) return;
    clearPreview();
    const controller = new AbortController();
    job.current = controller;
    setOpen(true);
    setBusy(true);
    try {
      const result = await exportShareImage(selected, controller.signal, getUserNickname());
      if (job.current !== controller) {
        disposeShareImage(result);
        return;
      }
      ownedImage.current = result;
      setImage(result);
    } catch (failure) {
      if (job.current === controller)
        setError(failure instanceof Error ? failure.message : '分享图生成失败，请重试。');
    } finally {
      if (job.current === controller) {
        job.current = null;
        setBusy(false);
      }
    }
  };
  return {
    selecting,
    selection: selecting ? { selectedIds, onToggle: toggle } : undefined,
    count: selected.length,
    start: () => setSelecting(true),
    cancel,
    clearAll,
    generate,
    completeDownload: cancel,
    open,
    busy,
    error,
    image,
    close: clearPreview,
  };
}

import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-alert-dialog';
import { Check, LoaderCircle, Minus, Plus, X } from 'lucide-react';

export type AvatarCropImage = { url: string; width: number; height: number };
type Offset = { x: number; y: number };

export default function AvatarCropDialog({ image, onCancel, onSave }: {
  image: AvatarCropImage;
  onCancel: () => void;
  onSave: (blob: Blob) => Promise<void>;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<{ id: number; x: number; y: number; size: number; origin: Offset } | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const shortSide = Math.min(image.width, image.height);
  // Offsets are normalized to the crop frame, so resizing never changes the crop.
  const clampOffset = (value: Offset, scale = zoom): Offset => {
    const maxX = (image.width / shortSide * scale - 1) / 2;
    const maxY = (image.height / shortSide * scale - 1) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, value.x)), y: Math.max(-maxY, Math.min(maxY, value.y)) };
  };
  const changeZoom = (value: number) => {
    const next = Math.max(1, Math.min(3, value));
    setZoom(next);
    setOffset((current) => clampOffset(current, next));
  };
  const save = async () => {
    if (saving || !imageRef.current?.complete) return;
    setSaving(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1024;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      const side = shortSide / zoom;
      const position = clampOffset(offset);
      context.drawImage(imageRef.current!,
        (image.width - side) / 2 - position.x * side,
        (image.height - side) / 2 - position.y * side,
        side, side, 0, 0, 1024, 1024);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Export failed')), 'image/png');
      });
      await onSave(blob);
    } catch {
      setError('头像保存失败，请重试或检查浏览器存储空间');
      setSaving(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-avatar-preview-mask" onClick={() => { if (!saving) onCancel(); }} />
        <Dialog.Content className="app-avatar-crop-dialog" onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}>
          <header className="app-avatar-crop-header">
            <Dialog.Title>调整您的图片</Dialog.Title>
            <button type="button" aria-label="关闭头像调整" disabled={saving} onClick={onCancel}><X /></button>
          </header>
          <Dialog.Description className="app-avatar-crop-hint">拖动图片调整位置，缩放至合适大小</Dialog.Description>
          <div
            className="app-avatar-crop-stage"
            tabIndex={0}
            role="group"
            aria-label="头像裁剪区域，可拖动图片或用方向键调整位置"
            onPointerDown={(event) => {
              if (saving || (event.pointerType === 'mouse' && event.button !== 0)) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, size: event.currentTarget.getBoundingClientRect().width, origin: offset };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start || start.id !== event.pointerId) return;
              setOffset(clampOffset({ x: start.origin.x + (event.clientX - start.x) / start.size, y: start.origin.y + (event.clientY - start.y) / start.size }));
            }}
            onPointerUp={() => { drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onLostPointerCapture={() => { drag.current = null; }}
            onKeyDown={(event) => {
              if (saving || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              setOffset((current) => clampOffset({
                x: current.x + (event.key === 'ArrowLeft' ? -.02 : event.key === 'ArrowRight' ? .02 : 0),
                y: current.y + (event.key === 'ArrowUp' ? -.02 : event.key === 'ArrowDown' ? .02 : 0),
              }));
            }}
          >
            <img ref={imageRef} src={image.url} alt="待调整头像" draggable={false} style={{
              width: `${image.width / shortSide * zoom * 100}%`,
              height: `${image.height / shortSide * zoom * 100}%`,
              left: `${50 + offset.x * 100}%`, top: `${50 + offset.y * 100}%`,
            }} />
            <span className="app-avatar-crop-guide" aria-hidden="true" />
          </div>
          <div className="app-avatar-crop-slider">
            <button type="button" aria-label="缩小裁剪图片" disabled={saving || zoom <= 1} onClick={() => changeZoom(zoom - .1)}><Minus /></button>
            <input type="range" min="1" max="3" step="0.01" value={zoom} disabled={saving} aria-label="头像裁剪缩放" aria-valuetext={`${Math.round(zoom * 100)}%`} onChange={(event) => changeZoom(Number(event.target.value))} />
            <button type="button" aria-label="放大裁剪图片" disabled={saving || zoom >= 3} onClick={() => changeZoom(zoom + .1)}><Plus /></button>
          </div>
          {error && <p className="app-avatar-crop-error" role="alert">{error}</p>}
          <footer className="app-avatar-crop-footer">
            <button type="button" disabled={saving} onClick={onCancel}>取消</button>
            <button type="button" className="is-primary" disabled={saving} onClick={save}>
              {saving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}
              <span>{saving ? '正在保存…' : '保存'}</span>
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

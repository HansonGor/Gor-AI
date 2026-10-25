// 公共头像组件：登录后显示账号头像，未登录、没有头像或读取失败时显示默认的 Gor 图标
import React, { useEffect, useRef, useState } from 'react';
import * as AvatarDialog from '@radix-ui/react-alert-dialog';
import { Pencil, X } from 'lucide-react';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { USER_CONFIG } from '@/config';
import { useAccountAvatarUrl } from '@/user/avatar';
import './AppAvatar.less';
import AvatarCropDialog, { type AvatarCropImage } from './AvatarCropDialog';

interface AppAvatarProps {
  /** 头像图片地址；不传时取当前账号头像，未登录则为 USER_CONFIG.AVATAR_URL */
  src?: string;
  alt?: string;
  className?: string;
  /** 允许放大查看与修改（需同时提供 onSaveAvatar，否则只可查看） */
  editable?: boolean;
  /** 保存裁剪后的头像；失败时抛出的错误信息会显示在头像旁 */
  onSaveAvatar?: (image: Blob) => Promise<void>;
}

const AppAvatar: React.FC<AppAvatarProps> = ({
  src,
  alt = '用户头像',
  className,
  editable = false,
  onSaveAvatar,
}) => {
  const accountAvatar = useAccountAvatarUrl();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [cropImage, setCropImage] = useState<AvatarCropImage | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const avatarSrc = src || accountAvatar || USER_CONFIG.AVATAR_URL;
  useEffect(() => () => {
    if (cropImage) URL.revokeObjectURL(cropImage.url);
  }, [cropImage]);

  const changeAvatar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setError('请选择 PNG、JPG、WebP 或 GIF 图片');
      return;
    }
    const imageUrl = URL.createObjectURL(file);
    try {
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject;
        image.src = imageUrl;
      });
      setCropImage({ url: imageUrl, ...dimensions });
    } catch {
      URL.revokeObjectURL(imageUrl);
      setError('无法读取这张图片，请选择有效的图片文件');
    }
  };
  const avatar = (
  <Avatar className={cn('app-avatar overflow-hidden rounded-full', className)} aria-label={alt}>
    <AvatarImage src={avatarSrc} alt={alt} />
    {/* 头像读取失败时回退显示 Gor Logo 图标 */}
    <AvatarFallback className="overflow-hidden rounded-full bg-transparent">
      <img src={USER_CONFIG.AVATAR_URL} alt="Gor" className="h-full w-full object-cover" />
    </AvatarFallback>
  </Avatar>
  );
  if (!editable) return avatar;
  return (
    <>
      <div className="app-avatar-control">
        <button type="button" className="app-avatar-view" aria-label="放大查看头像" onClick={() => { setZoom(1); setPreviewOpen(true); }}>{avatar}</button>
        {onSaveAvatar && (
          <>
            <button type="button" className="app-avatar-edit" aria-label="修改头像" title="修改头像" onClick={() => inputRef.current?.click()}><Pencil aria-hidden="true" /></button>
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="app-avatar-file" aria-label="选择头像图片" onChange={changeAvatar} />
          </>
        )}
        {error && <span className="app-avatar-error" role="alert" onClick={() => setError('')}>{error}</span>}
      </div>
      <AvatarDialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
        <AvatarDialog.Portal>
          <AvatarDialog.Overlay className="app-avatar-preview-mask" onClick={() => setPreviewOpen(false)} />
          <AvatarDialog.Content
            className="app-avatar-preview"
            style={{ '--avatar-preview-zoom': zoom } as React.CSSProperties}
            onWheel={(event) => setZoom((value) => Math.min(3, Math.max(1, value + (event.deltaY < 0 ? .15 : -.15))))}
          >
            <AvatarDialog.Title className="sr-only">头像预览</AvatarDialog.Title>
            <AvatarDialog.Description className="sr-only">使用滚轮放大整个头像，最小为打开时的大小，按 Esc 或点击遮罩关闭</AvatarDialog.Description>
            <div className="app-avatar-preview-image">
              <img src={avatarSrc} alt={alt} onError={(event) => { event.currentTarget.src = USER_CONFIG.AVATAR_URL; }} />
            </div>
            <AvatarDialog.Cancel className="app-avatar-preview-close" aria-label="关闭头像预览"><X /></AvatarDialog.Cancel>
          </AvatarDialog.Content>
        </AvatarDialog.Portal>
      </AvatarDialog.Root>
      {cropImage && onSaveAvatar && (
        <AvatarCropDialog
          image={cropImage}
          onCancel={() => setCropImage(null)}
          onSave={async (blob) => {
            try {
              await onSaveAvatar(blob);
            } catch (reason) {
              setError(reason instanceof Error && reason.message ? reason.message : '头像保存失败，请稍后再试');
            }
            setCropImage(null);
          }}
        />
      )}
    </>
  );
};

export default AppAvatar;

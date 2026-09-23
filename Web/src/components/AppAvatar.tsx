// 公共头像组件：优先加载用户头像，读取失败时默认显示 Gor App 图标
import React from 'react';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { USER_CONFIG } from '@/config';

interface AppAvatarProps {
  /** 头像图片地址，默认取 USER_CONFIG.AVATAR_URL */
  src?: string;
  alt?: string;
  className?: string;
}

const AppAvatar: React.FC<AppAvatarProps> = ({
  src = USER_CONFIG.AVATAR_URL,
  alt = '用户头像',
  className,
}) => (
  <Avatar className={cn('app-avatar overflow-hidden rounded-full', className)} aria-label={alt}>
    <AvatarImage src={src} alt={alt} />
    {/* 头像读取失败时回退显示 Gor Logo 图标 */}
    <AvatarFallback className="overflow-hidden rounded-full bg-transparent">
      <img src="/icon-192.png" alt="Gor" className="h-full w-full object-cover" />
    </AvatarFallback>
  </Avatar>
);

export default AppAvatar;

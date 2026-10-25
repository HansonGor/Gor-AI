/**
 * 账号头像：保存在服务端账号下，Web 与插件共用；未登录时显示默认的 Gor 头像。
 * 读取走 fetch（插件里由 vscodeRuntime 附加 Bearer 凭证，<img> 直连带不了），转成 blob 地址显示。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { ensureCurrentUser, updateAuthUser, useAuth, type AuthUser } from './auth';

let avatarUrl = '';
let avatarKey = '';
const listeners = new Set<() => void>();

function publish(url: string, key: string): void {
  if (avatarUrl && avatarUrl !== url) URL.revokeObjectURL(avatarUrl);
  avatarUrl = url;
  avatarKey = key;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadAvatar(user: AuthUser | null): Promise<void> {
  const key = user?.avatarVersion ? `${user.id}:${user.avatarVersion}` : '';
  if (key === avatarKey) return;
  if (!key) {
    publish('', '');
    return;
  }
  avatarKey = key;
  try {
    const response = await fetch(`/api/auth/avatar?v=${user!.avatarVersion}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(String(response.status));
    const url = URL.createObjectURL(await response.blob());
    if (avatarKey === key) publish(url, key);
    else URL.revokeObjectURL(url);
  } catch {
    // 读取失败显示默认头像，下次版本变化时再试
    if (avatarKey === key) publish('', '');
  }
}

/** 当前账号头像的 blob 地址；未登录或没有头像时为空字符串（由调用方显示默认头像）。 */
export function useAccountAvatarUrl(): string {
  const { user } = useAuth();
  useEffect(() => { void ensureCurrentUser(); }, []);
  useEffect(() => { void loadAvatar(user); }, [user?.id, user?.avatarVersion]);
  return useSyncExternalStore(subscribe, () => avatarUrl, () => avatarUrl);
}

export async function uploadAccountAvatar(image: Blob): Promise<AuthUser> {
  const response = await fetch('/api/auth/avatar', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': image.type || 'application/octet-stream' },
    body: image,
  });
  let data: any = {};
  try { data = await response.json(); } catch { /* 按状态码提示 */ }
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '头像保存失败，请稍后再试');
  updateAuthUser(data.user);
  return data.user;
}

// ---- 账号上线前，头像只存在本机浏览器：首次登录且账号还没有头像时，迁移一次到账号下 ----
const LEGACY_STORAGE_KEY = 'gor-custom-avatar';
const LEGACY_MIGRATED_KEY = 'gor-avatar-migrated';

async function loadLegacyAvatarBlob(): Promise<Blob | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('gor-avatar', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function legacyAvatar(): Promise<Blob | undefined> {
  try {
    const blob = await loadLegacyAvatarBlob();
    if (blob) return blob;
  } catch { /* IndexedDB 不可用时再看旧的 data URL */ }
  try {
    const dataUrl = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (dataUrl?.startsWith('data:image/')) return await (await fetch(dataUrl)).blob();
  } catch { /* 没有本机头像 */ }
  return undefined;
}

/** 本机只迁移一次（避免同一浏览器后来注册的其他账号也拿到这张头像）；不删除本机原图。 */
export async function migrateLegacyAvatar(user: AuthUser | null): Promise<void> {
  if (!user || user.avatarVersion) return;
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return;
  } catch {
    return;
  }
  const blob = await legacyAvatar();
  if (!blob) return;
  try {
    await uploadAccountAvatar(blob);
    localStorage.setItem(LEGACY_MIGRATED_KEY, user.id);
  } catch { /* 迁移失败下次登录再试 */ }
}

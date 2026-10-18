/**
 * 当前用户的显示名（左下角账号昵称）。账号体系接入前先用固定昵称；
 * 以后只需让 getUserNickname 读取真实账号，侧栏与分享图都会跟着变。
 */
export const DEFAULT_USER_NICKNAME = '樺';

/** 分享图等没有昵称可用时的称呼。 */
export const FALLBACK_USER_LABEL = '你';

export function getUserNickname(): string {
  return DEFAULT_USER_NICKNAME.trim() || FALLBACK_USER_LABEL;
}

import { getAuthState } from './auth';

/** 分享图等没有昵称可用时的称呼（未登录时即用它）。 */
export const FALLBACK_USER_LABEL = '你';

/** 当前用户的显示名：登录后取账号昵称；侧栏与分享图共用这一来源。 */
export function getUserNickname(): string {
  return getAuthState().user?.nickname.trim() || FALLBACK_USER_LABEL;
}

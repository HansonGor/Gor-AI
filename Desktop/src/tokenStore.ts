import { promises as fs } from 'node:fs';
import type { TokenStore } from './protocol';

export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * 登录凭证保存在用户数据目录下，用系统加密（Windows DPAPI / macOS 钥匙串 / Linux 密钥环）加密；
 * 系统加密不可用时只保存在内存中，绝不明文落盘。
 */
export function createTokenStore(file: string, cipher: Cipher, log: (message: string) => void = () => undefined): TokenStore & { load(): Promise<void> } {
  let token: string | null = null;
  return {
    async load() {
      if (!cipher.available()) return;
      try {
        token = cipher.decrypt(await fs.readFile(file)) || null;
      } catch {
        token = null;
      }
    },
    get: () => token,
    async set(next, persist) {
      token = next;
      try {
        if (persist && cipher.available()) await fs.writeFile(file, cipher.encrypt(next), { mode: 0o600 });
        else await fs.rm(file, { force: true });
      } catch (error) {
        log(`[Gor Desktop] Could not store sign-in state: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async clear() {
      token = null;
      try { await fs.rm(file, { force: true }); } catch { /* 文件不存在即视为已清除 */ }
    },
  };
}

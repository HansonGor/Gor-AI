const STORAGE_LIMIT_BYTES = 512 * 1024;

/** Volatile Web Storage for the opaque sandbox origin. Never persists or escapes the iframe. */
export class SandboxStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string): void {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    const size = [...this.values.entries()].reduce((total, [entryKey, entryValue]) => {
      if (entryKey === normalizedKey) return total;
      return total + (entryKey.length + entryValue.length) * 2;
    }, 0) + (normalizedKey.length + normalizedValue.length) * 2;
    if (size > STORAGE_LIMIT_BYTES) {
      throw new DOMException('Preview storage quota exceeded.', 'QuotaExceededError');
    }
    this.values.set(normalizedKey, normalizedValue);
  }
}

export function installSandboxStorage(target: Window): void {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    value: new SandboxStorage(),
  });
  Object.defineProperty(target, 'sessionStorage', {
    configurable: true,
    value: new SandboxStorage(),
  });
}

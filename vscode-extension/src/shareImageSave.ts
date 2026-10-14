export function decodeSharePng(base64: unknown): Uint8Array {
  if (typeof base64 !== 'string' || base64.length > 45 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('无效的分享图片。');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('仅支持保存 PNG 分享图片。');
  return bytes;
}

// SSE 流解析工具
// 将 ReadableStream 解析为异步事件生成器
import type { SSEEvent } from '../types';

/**
 * 解析 SSE 流
 * @param {ReadableStream} body - fetch response.body
 * @returns {AsyncGenerator<SSEEvent>} 解析后的事件对象 { type, ...payload }
 */
export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // 保留不完整的行

      for (const line of lines) {
        const event = parseSSELine(line);
        if (event) {
          yield event;
        }
      }
    }

    // 处理缓冲区中剩余的最后一行
    if (buffer.trim()) {
      const event = parseSSELine(buffer);
      if (event) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 解析单行 SSE 数据
 * @param {string} line
 * @returns {SSEEvent|null}
 */
function parseSSELine(line: string): SSEEvent | null {
  const trimmed = line.trim();

  // 跳过空行和心跳注释
  if (!trimmed || trimmed.startsWith(':')) {
    return null;
  }

  // 只处理 data: 开头的行
  if (!trimmed.startsWith('data:')) {
    return null;
  }

  const dataStr = trimmed.slice(5).trim();
  if (!dataStr) {
    return null;
  }

  try {
    return JSON.parse(dataStr) as SSEEvent;
  } catch {
    return null;
  }
}

export default parseSSEStream;

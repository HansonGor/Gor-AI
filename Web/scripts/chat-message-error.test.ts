import assert from 'node:assert/strict';
import test from 'node:test';
import { appendMessageErrorOnce } from '../src/utils/chatMessageError.ts';

test('same SSE error reported by callback and rejected promise is appended only once', () => {
  const once = appendMessageErrorOnce('已有回复', '请求失败', '服务异常');
  assert.equal(appendMessageErrorOnce(once, '请求失败', '发送失败，请重试'), '已有回复\n\n错误：请求失败');
});

test('distinct errors remain visible and empty replies still show the fallback', () => {
  const first = appendMessageErrorOnce('', undefined, '服务异常');
  assert.equal(appendMessageErrorOnce(first, '后续请求失败', '发送失败，请重试'), '\n\n错误：服务异常\n\n错误：后续请求失败');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeSharePng } = require('../out/shareImageSave');
const Module = require('node:module');
let chosenUri, failSave, pickerCalls = 0, writes = [], replies = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {
    Uri: { file: path => ({ path }) },
    window: { registerWebviewViewProvider: () => ({ dispose() {} }), showSaveDialog: async () => { pickerCalls++; return chosenUri; } },
    workspace: { fs: { writeFile: async (uri, bytes) => { if (failSave) throw new Error('权限失败'); writes.push({ uri, bytes }); } } },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { ChatView } = require('../out/chatPanel');
Module._load = originalLoad;
test('share saver accepts PNG bytes and rejects invalid, other formats and oversized payloads', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  assert.deepEqual(decodeSharePng(png.toString('base64')), png);
  for (const input of [null, '', '../path', 'evil<script>', Buffer.from('not png').toString('base64'), 'A'.repeat(45 * 1024 * 1024 + 1)]) assert.throws(() => decodeSharePng(input));
});
test('native share handler saves only after user destination choice and reports cancel/errors', async () => {
  const provider = ChatView.register({}, { appendLine() {} });
  provider.webview = { postMessage: async reply => { replies.push(reply); } };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const request = { type: 'gor.saveShareImage', requestId: 'share-request', suggestedName: 'Gor-聊天-1.png', base64: png };
  chosenUri = undefined; await provider.handleMessage(request); assert.equal(writes.length, 0); assert.equal(replies.at(-1).saved, false);
  chosenUri = { path: 'user-selected.png' }; await provider.handleMessage(request); assert.equal(writes.length, 1); assert.equal(writes[0].uri, chosenUri); assert.deepEqual(writes[0].bytes, Buffer.from(png, 'base64')); assert.equal(replies.at(-1).saved, true); assert.equal(replies.at(-1).requestId, 'share-request');
  failSave = true; await provider.handleMessage(request); assert.match(replies.at(-1).error, /权限失败/); assert.equal(replies.at(-1).saved, false);
  const before = pickerCalls; await provider.handleMessage({ ...request, base64: 'invalid' }); assert.equal(pickerCalls, before); assert.equal(writes.length, 1);
});

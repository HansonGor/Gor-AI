const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
require('../out/workspace/vscodeHost.js').installVsCodeWorkspaceHost();
const { normalizeWorkspaceRelativePath, isUriWithinWorkspaceRoot } = require('@gor/workspace-core/out/paths.js');
Module._load = originalLoad;

test('normalizes workspace-relative paths and rejects traversal and absolute paths', () => {
  assert.equal(normalizeWorkspaceRelativePath('/src/App.tsx'), '/src/App.tsx');
  assert.equal(normalizeWorkspaceRelativePath('src/App.tsx'), '/src/App.tsx');
  for (const value of ['../outside.ts', '/src/../../outside.ts', 'C:\\Windows\\win.ini', 'file:///etc/passwd', '//server/share']) {
    assert.throws(() => normalizeWorkspaceRelativePath(value), (error) => error.code === 'INVALID_PATH');
  }
  for (const value of ['/.git/config', '/node_modules/pkg/index.js', '/.env', '/keys/private.pem']) {
    assert.throws(() => normalizeWorkspaceRelativePath(value), (error) => error.code === 'INVALID_PATH');
  }
});

test('URI containment checks path boundaries and URI authority', () => {
  const root = { uri: { scheme: 'file', authority: '', path: '/project' } };
  assert.equal(isUriWithinWorkspaceRoot({ scheme: 'file', authority: '', path: '/project/src/App.tsx' }, root), true);
  assert.equal(isUriWithinWorkspaceRoot({ scheme: 'file', authority: '', path: '/project-other/App.tsx' }, root), false);
  assert.equal(isUriWithinWorkspaceRoot({ scheme: 'file', authority: 'remote', path: '/project/src/App.tsx' }, root), false);
});

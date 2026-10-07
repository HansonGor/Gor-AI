const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

class Uri {
  constructor(scheme, authority, value) { this.scheme = scheme; this.authority = authority; this.path = value; }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
  static joinPath(base, ...segments) { return new Uri(base.scheme, base.authority, path.posix.join(base.path, ...segments)); }
}
class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class RelativePattern { constructor(baseUri, pattern) { this.baseUri = baseUri.uri ?? baseUri; this.pattern = pattern; } }
class WorkspaceEdit {
  constructor() { this.edits = []; this.creates = []; }
  replace(uri, range, newText) { this.edits.push({ uri, range, newText }); }
  createFile(uri, options) { this.creates.push({ uri, options }); }
}

const rootUri = new Uri('file', '', '/workspace');
const secondRootUri = new Uri('file', '', '/workspace-two');
const firstFolder = { name: 'frontend', uri: rootUri };
const secondFolder = { name: 'backend', uri: secondRootUri };
const documentUri = Uri.joinPath(rootUri, 'src', 'App.tsx');
const styleUri = Uri.joinPath(rootUri, 'src', 'style.css');
const testUri = Uri.joinPath(rootUri, 'src', 'test.ts');
const initialSource = "const title = 'unsaved title';\nexport const count = 0;\nexport function App() {\n  return count;\n}\n";
let saveCalls = 0;
let applyCalls = 0;
let lastWorkspaceEdit;
let failNextApply = false;
let diskFiles = new Map();
let directories = new Set([rootUri.path, `${rootUri.path}/src`]);
let trashCalls = [];

function createDocument(uri, initialText, initialVersion) {
  return {
    uri,
    version: initialVersion,
    content: initialText,
    isDirty: false,
    get lineCount() { return this.content.split(/\r\n|\n|\r/).length; },
    getText(range) {
      if (!range) return this.content;
      return this.content.slice(this.offsetAt(range.start), this.offsetAt(range.end));
    },
    positionAt(offset) {
      const prefix = this.content.slice(0, Math.max(0, Math.min(offset, this.content.length)));
      const lines = prefix.split(/\r\n|\n|\r/);
      return new Position(lines.length - 1, lines.at(-1).length);
    },
    offsetAt(position) {
      const lines = this.content.split(/\r\n|\n|\r/);
      let offset = 0;
      for (let index = 0; index < Math.min(position.line, lines.length); index += 1) {
        offset += lines[index].length;
        const separator = this.content.slice(offset).match(/^\r\n|^\n|^\r/);
        if (separator) offset += separator[0].length;
      }
      return Math.min(this.content.length, offset + position.character);
    },
    lineAt(index) {
      const text = this.content.split(/\r\n|\n|\r/)[index] ?? '';
      return { text, range: { end: new Position(index, text.length) } };
    },
    async save() { saveCalls += 1; return true; },
  };
}

const document = createDocument(documentUri, initialSource, 7);
const styleDocument = createDocument(styleUri, 'body { color: red; }\n', 4);
const testDocument = createDocument(testUri, 'export const value = 1;\n', 3);
const workspace = {
  workspaceFolders: [firstFolder],
  textDocuments: [document, styleDocument, testDocument],
  async findFiles(pattern) {
    if (pattern.baseUri.path === secondRootUri.path) return [Uri.joinPath(secondRootUri, 'package.json')];
    return [documentUri, styleUri, testUri];
  },
  fs: {
    async stat(uri) {
      const found = thisDocuments().find((item) => item.uri.toString() === uri.toString());
      if (found) return { type: 1, size: found.getText().length };
      if (uri.path.endsWith('package.json')) return { type: 1, size: 20 };
      if (diskFiles.has(uri.path)) return { type: 1, size: diskFiles.get(uri.path).byteLength };
      if (directories.has(uri.path)) return { type: 2, size: 0 };
      throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
    },
    async readDirectory(uri) {
      if (!directories.has(uri.path)) throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
      if (uri.path === secondRootUri.path) return [['package.json', 1]];
      const entries = new Map();
      const prefix = `${uri.path.replace(/\/$/, '')}/`;
      for (const directory of directories) {
        if (!directory.startsWith(prefix)) continue;
        const name = directory.slice(prefix.length).split('/')[0];
        if (name) entries.set(name, 2);
      }
      for (const file of [...workspace.textDocuments.map((item) => item.uri.path), ...diskFiles.keys()]) {
        if (!file.startsWith(prefix)) continue;
        const name = file.slice(prefix.length).split('/')[0];
        if (name && !entries.has(name)) entries.set(name, 1);
      }
      return [...entries.entries()];
    },
    async createDirectory(uri) {
      const segments = uri.path.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments) {
        current += `/${segment}`;
        directories.add(current);
      }
    },
    async delete(uri, options) {
      trashCalls.push({ uri, options });
      if (directories.has(uri.path)) {
        const entries = await this.readDirectory(uri);
        if (!options.recursive && entries.length) throw Object.assign(new Error('Directory not empty'), { code: 'NoPermissions' });
        directories.delete(uri.path);
        return;
      }
      if (!diskFiles.delete(uri.path) && !workspace.textDocuments.some((item) => item.uri.path === uri.path)) {
        throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
      }
    },
  },
  async openTextDocument(uri) {
    const found = this.textDocuments.find((item) => item.uri.toString() === uri.toString());
    if (found) return found;
    throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
  },
  async applyEdit(edit) {
    applyCalls += 1;
    lastWorkspaceEdit = edit;
    if (failNextApply) { failNextApply = false; return false; }
    const byDocument = new Map();
    for (const creation of edit.creates) {
      if (diskFiles.has(creation.uri.path) || this.textDocuments.some((item) => item.uri.path === creation.uri.path)) return false;
      diskFiles.set(creation.uri.path, creation.options.contents ?? new Uint8Array());
    }
    for (const item of edit.edits) {
      const target = this.textDocuments.find((candidate) => candidate.uri.toString() === item.uri.toString());
      assert.ok(target, 'WorkspaceEdit must target an open TextDocument');
      const edits = byDocument.get(target) ?? [];
      edits.push(item);
      byDocument.set(target, edits);
    }
    for (const [target, edits] of byDocument) {
      let next = target.content;
      for (const item of edits.sort((left, right) => target.offsetAt(right.range.start) - target.offsetAt(left.range.start))) {
        const start = target.offsetAt(item.range.start);
        const end = target.offsetAt(item.range.end);
        next = next.slice(0, start) + item.newText + next.slice(end);
      }
      target.content = next;
      target.version += 1;
      target.isDirty = true;
    }
    return true;
  },
  onDidChangeTextDocument() { return { dispose() {} }; },
};
function thisDocuments() { return workspace.textDocuments; }

const vscodeStub = {
  workspace,
  window: { activeTextEditor: { document } },
  Uri,
  Position,
  Range,
  RelativePattern,
  WorkspaceEdit,
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};
const { WorkspaceRequestHandler } = require('../out/workspace/requestHandler.js');
Module._load = originalLoad;

function reset() {
  document.content = initialSource;
  document.version = 7;
  document.isDirty = false;
  styleDocument.content = 'body { color: red; }\n';
  styleDocument.version = 4;
  styleDocument.isDirty = false;
  testDocument.content = 'export const value = 1;\n';
  testDocument.version = 3;
  testDocument.isDirty = false;
  workspace.workspaceFolders = [firstFolder];
  workspace.textDocuments = [document, styleDocument, testDocument];
  saveCalls = 0;
  applyCalls = 0;
  lastWorkspaceEdit = undefined;
  failNextApply = false;
  diskFiles = new Map();
  directories = new Set([rootUri.path, `${rootUri.path}/src`, secondRootUri.path]);
  trashCalls = [];
}

async function invoke(handler, method, params, workspaceId = 'vscode-test') {
  let response;
  await handler.handle({
    type: 'workspace_request', requestId: 'req-test', workspaceId, method, params,
  }, 'vscode-test', (value) => { response = value; return true; });
  return response;
}

test('read and search use the current unsaved TextDocument and return fileVersion', async () => {
  reset();
  document.content = document.content.replace('unsaved title', 'manually edited unsaved title');
  document.version = 8;
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const read = await invoke(handler, 'project.readFile', { path: '/src/App.tsx', startLine: 1, endLine: 2 });
  assert.equal(read.success, true);
  assert.match(read.result.content, /manually edited unsaved title/);
  assert.equal(read.result.fileVersion, 8);
  assert.equal(read.result.path, '/src/App.tsx');

  const search = await invoke(handler, 'project.searchCode', { query: 'manually edited', maxResults: 20 });
  assert.equal(search.success, true);
  assert.equal(search.result.results[0].path, '/src/App.tsx');
  assert.match(search.result.results[0].snippet, /manually edited unsaved title/);
});

test('patch edits the latest unsaved TextDocument once, leaves it dirty, and never saves', async () => {
  reset();
  document.content = document.content.replace('unsaved title', 'unsaved counter title');
  document.version = 8;
  const output = [];
  const handler = new WorkspaceRequestHandler({ appendLine(line) { output.push(line); } });
  const result = await invoke(handler, 'project.patchFile', {
    path: '/src/App.tsx', oldText: 'unsaved counter title', newText: 'Gor title', expectedFileVersion: 8,
  });
  assert.equal(result.success, true);
  assert.equal(result.result.changed, true);
  assert.match(document.getText(), /Gor title/);
  assert.equal(document.version, 9);
  assert.equal(document.isDirty, true);
  assert.equal(applyCalls, 1);
  assert.equal(lastWorkspaceEdit.edits.length, 1);
  assert.equal(saveCalls, 0);
  assert.match(result.result.diff, /-const title = 'unsaved counter title';/);
  assert.match(result.result.diff, /\+const title = 'Gor title';/);
  assert.equal('content' in result.result, false);
  assert.equal(result.result.diff.includes(document.getText()), false);
  assert.ok(output.includes('[Gor Workspace] patchFile /src/App.tsx'));
  assert.ok(output.includes('[Gor Workspace] applyEdit success'));
  assert.equal(output.join('\n').includes('unsaved counter title'), false);
});

test('patch distinguishes no match, non-unique match, stale versions, binary files, and paths', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  let response = await invoke(handler, 'project.patchFile', {
    path: '/src/App.tsx', oldText: 'not present', newText: 'x', expectedFileVersion: 7,
  });
  assert.equal(response.error.code, 'PATCH_TARGET_NOT_FOUND');
  assert.equal(applyCalls, 0);

  document.content = 'same same';
  response = await invoke(handler, 'project.patchFile', { path: '/src/App.tsx', oldText: 'same', newText: 'x' });
  assert.equal(response.error.code, 'PATCH_TARGET_NOT_UNIQUE');
  assert.equal(document.getText(), 'same same');

  response = await invoke(handler, 'project.patchFile', {
    path: '/src/App.tsx', oldText: 'same', newText: 'new', expectedFileVersion: 6,
  });
  assert.equal(response.error.code, 'VERSION_CONFLICT');
  assert.equal(document.getText(), 'same same');

  response = await invoke(handler, 'project.patchFile', { path: '/src/logo.png', oldText: 'x', newText: 'y' });
  assert.equal(response.error.code, 'UNSUPPORTED_FILE_TYPE');
  response = await invoke(handler, 'project.patchFile', {
    path: '/src/App.tsx', oldText: 'same', newText: 'binary\0data',
  });
  assert.equal(response.error.code, 'UNSUPPORTED_FILE_TYPE');
  response = await invoke(handler, 'project.patchFile', { path: '../../../outside.ts', oldText: 'x', newText: 'y' });
  assert.equal(response.error.code, 'INVALID_PATH');
  assert.equal(applyCalls, 0);
});

test('batch validates all files then commits same-file and cross-file patches with one WorkspaceEdit', async () => {
  reset();
  document.content = 'const title = "计数器";\nconst action = "计数";\n';
  styleDocument.content = '.count { color: red; }\n';
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const response = await invoke(handler, 'project.applyPatches', { patches: [
    { path: '/src/App.tsx', oldText: '计数器', newText: '计次器', expectedFileVersion: 7 },
    { path: '/src/App.tsx', oldText: '"计数"', newText: '"次数"', expectedFileVersion: 7 },
    { path: '/src/style.css', oldText: 'red', newText: 'blue', expectedFileVersion: 4 },
  ] });
  assert.equal(response.success, true);
  assert.equal(response.result.patchCount, 3);
  assert.equal(response.result.changedFiles.length, 2);
  assert.match(document.getText(), /计次器/);
  assert.match(document.getText(), /"次数"/);
  assert.match(styleDocument.getText(), /blue/);
  assert.equal(document.version, 8);
  assert.equal(styleDocument.version, 5);
  assert.equal(applyCalls, 1);
  assert.equal(lastWorkspaceEdit.edits.length, 3);
  assert.equal(saveCalls, 0);
});

test('batch failure and overlap are atomic and do not change any TextDocument', async () => {
  reset();
  const originalApp = document.getText();
  const originalCss = styleDocument.getText();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  let response = await invoke(handler, 'project.applyPatches', { patches: [
    { path: '/src/App.tsx', oldText: 'unsaved title', newText: 'changed title', expectedFileVersion: 7 },
    { path: '/src/style.css', oldText: 'not present', newText: 'blue', expectedFileVersion: 4 },
  ] });
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'PATCH_TARGET_NOT_FOUND');
  assert.equal(document.getText(), originalApp);
  assert.equal(styleDocument.getText(), originalCss);
  assert.equal(applyCalls, 0);

  document.content = 'abcdef';
  response = await invoke(handler, 'project.applyPatches', { patches: [
    { path: '/src/App.tsx', oldText: 'bcd', newText: 'X', expectedFileVersion: 7 },
    { path: '/src/App.tsx', oldText: 'cde', newText: 'Y', expectedFileVersion: 7 },
  ] });
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'PATCH_OVERLAP_CONFLICT');
  assert.equal(document.getText(), 'abcdef');
  assert.equal(applyCalls, 0);
});

test('write replaces only an existing text file via WorkspaceEdit without saving', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const response = await invoke(handler, 'project.writeFile', {
    path: '/src/test.ts', content: 'export const value = 2;\n', expectedFileVersion: 3,
  });
  assert.equal(response.success, true);
  assert.equal(response.result.changed, true);
  assert.equal(testDocument.getText(), 'export const value = 2;\n');
  assert.equal(testDocument.isDirty, true);
  assert.equal(testDocument.version, 4);
  assert.equal(applyCalls, 1);
  assert.equal(lastWorkspaceEdit.edits.length, 1);
  assert.equal(saveCalls, 0);
  assert.equal('content' in response.result, false);

  const missing = await invoke(handler, 'project.writeFile', { path: '/src/new.ts', content: 'new file' });
  assert.equal(missing.success, false);
  assert.equal(missing.error.code, 'FILE_NOT_FOUND');
  assert.equal(applyCalls, 1);
});

test('VS Code refusal to apply WorkspaceEdit returns WORKSPACE_EDIT_FAILED without saving', async () => {
  reset();
  failNextApply = true;
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const response = await invoke(handler, 'project.patchFile', {
    path: '/src/App.tsx', oldText: 'unsaved title', newText: 'new title', expectedFileVersion: 7,
  });
  assert.equal(response.success, false);
  assert.equal(response.error.code, 'WORKSPACE_EDIT_FAILED');
  assert.equal(document.getText(), initialSource);
  assert.equal(saveCalls, 0);
});

test('createFile creates a new text file without overwriting and hides its content from results/logs', async () => {
  reset();
  const output = [];
  const handler = new WorkspaceRequestHandler({ appendLine(line) { output.push(line); } });
  const created = await invoke(handler, 'project.createFile', {
    path: '/src/new-component.tsx', content: 'export const NewComponent = () => null;',
  });
  assert.deepEqual(created.result, { success: true, path: '/src/new-component.tsx', created: true });
  assert.equal(new TextDecoder().decode(diskFiles.get('/workspace/src/new-component.tsx')), 'export const NewComponent = () => null;');
  assert.equal(lastWorkspaceEdit.creates[0].options.overwrite, false);
  assert.equal(lastWorkspaceEdit.creates[0].options.contents instanceof Uint8Array, true);
  assert.equal(workspace.textDocuments.some((item) => item.uri.path === '/workspace/src/new-component.tsx'), false);
  assert.equal(output.some((line) => line.includes('export const NewComponent')), false);

  const duplicate = await invoke(handler, 'project.createFile', {
    path: '/src/new-component.tsx', content: 'should not replace',
  });
  assert.equal(duplicate.error.code, 'FILE_ALREADY_EXISTS');
  assert.equal(new TextDecoder().decode(diskFiles.get('/workspace/src/new-component.tsx')), 'export const NewComponent = () => null;');

  const existing = await invoke(handler, 'project.createFile', { path: '/src/App.tsx', content: 'replacement' });
  assert.equal(existing.error.code, 'FILE_ALREADY_EXISTS');
  assert.match(document.getText(), /unsaved title/);
});

test('createFile requires an existing parent; createDirectory uses VS Code mkdirp and detects existing paths', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const missingParent = await invoke(handler, 'project.createFile', { path: '/src/new/deep.ts', content: '' });
  assert.equal(missingParent.error.code, 'DIRECTORY_NOT_FOUND');

  const created = await invoke(handler, 'project.createDirectory', { path: '/src/new/deep' });
  assert.deepEqual(created.result, { success: true, path: '/src/new/deep', created: true });
  assert.ok(directories.has('/workspace/src/new/deep'));
  const duplicate = await invoke(handler, 'project.createDirectory', { path: '/src/new/deep' });
  assert.equal(duplicate.error.code, 'DIRECTORY_ALREADY_EXISTS');
});

test('deleteFile protects dirty documents, checks versions, and requests the system trash', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  document.version = 8;
  const conflict = await invoke(handler, 'project.deleteFile', { path: '/src/App.tsx', expectedFileVersion: 7 });
  assert.equal(conflict.error.code, 'VERSION_CONFLICT');

  document.isDirty = true;
  const dirty = await invoke(handler, 'project.deleteFile', { path: '/src/App.tsx', expectedFileVersion: 8 });
  assert.equal(dirty.error.code, 'FILE_HAS_UNSAVED_CHANGES');
  assert.equal(trashCalls.length, 0);

  document.isDirty = false;
  const deleted = await invoke(handler, 'project.deleteFile', { path: '/src/App.tsx', expectedFileVersion: 8 });
  assert.deepEqual(deleted.result, { success: true, path: '/src/App.tsx', deleted: true });
  assert.deepEqual(trashCalls.at(-1).options, { recursive: false, useTrash: true });
});

test('deleteDirectory refuses roots, metadata, recursion, dirty descendants, and non-empty folders', async () => {
  reset();
  directories.add('/workspace/src/old');
  directories.add('/workspace/src/old/nested');
  diskFiles.set('/workspace/src/old/nested/file.ts', new TextEncoder().encode('x'));
  const oldDocument = createDocument(Uri.joinPath(rootUri, 'src', 'old', 'open.ts'), 'unsaved', 1);
  oldDocument.isDirty = true;
  workspace.textDocuments.push(oldDocument);
  const handler = new WorkspaceRequestHandler({ appendLine() {} });

  assert.equal((await invoke(handler, 'project.deleteDirectory', { path: '/' })).error.code, 'WORKSPACE_ROOT_PROTECTED');
  assert.equal((await invoke(handler, 'project.deleteDirectory', { path: '/.git' })).error.code, 'PROTECTED_PATH');
  assert.equal((await invoke(handler, 'project.deleteDirectory', { path: '/.vscode' })).error.code, 'PROTECTED_PATH');
  assert.equal((await invoke(handler, 'project.deleteDirectory', { path: '/src/old', recursive: true })).error.code, 'UNSUPPORTED_OPERATION');
  assert.equal((await invoke(handler, 'project.deleteDirectory', { path: '/src/old' })).error.code, 'DIRECTORY_HAS_UNSAVED_CHANGES');

  oldDocument.isDirty = false;
  const nonEmpty = await invoke(handler, 'project.deleteDirectory', { path: '/src/old' });
  assert.equal(nonEmpty.error.code, 'DIRECTORY_NOT_EMPTY');
  assert.ok(directories.has('/workspace/src/old'));
  assert.equal(trashCalls.length, 0);

  directories.add('/workspace/src/empty');
  const deleted = await invoke(handler, 'project.deleteDirectory', { path: '/src/empty' });
  assert.deepEqual(deleted.result, { success: true, path: '/src/empty', deleted: true });
  assert.deepEqual(trashCalls.at(-1).options, { recursive: false, useTrash: true });
});

test('create and delete reject traversal, absolute paths, and file URIs', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  for (const pathValue of ['../../../outside.ts', 'C:\\outside.ts', 'file:///outside.ts']) {
    const created = await invoke(handler, 'project.createFile', { path: pathValue, content: 'x' });
    assert.equal(created.error.code, 'INVALID_PATH');
    const deleted = await invoke(handler, 'project.deleteDirectory', { path: pathValue });
    assert.equal(deleted.error.code, 'INVALID_PATH');
  }
});

test('listProjectFiles returns the actual workspace files and directories', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const listed = await invoke(handler, 'project.listFiles', { root: 'root-1' });
  assert.equal(listed.success, true);
  assert.ok(listed.result.files.includes('/src/App.tsx'));
  assert.ok(listed.result.directories.includes('/src'));
  assert.equal(listed.result.files.some((path) => path.includes('secret')), false);
});

test('rejects traversal paths and requires an explicit root for multi-root workspaces', async () => {
  reset();
  const handler = new WorkspaceRequestHandler({ appendLine() {} });
  const traversal = await invoke(handler, 'project.readFile', { path: '../../../outside.txt' });
  assert.equal(traversal.success, false);
  assert.equal(traversal.error.code, 'INVALID_PATH');

  workspace.workspaceFolders = [firstFolder, secondFolder];
  const missingRoot = await invoke(handler, 'project.listFiles', {});
  assert.equal(missingRoot.success, false);
  assert.equal(missingRoot.error.code, 'WORKSPACE_ROOT_REQUIRED');

  const selectedRoot = await invoke(handler, 'project.listFiles', { root: 'root-2', workspaceVersion: 3 });
  assert.equal(selectedRoot.success, true);
  assert.equal(selectedRoot.result.root, 'root-2');
  assert.equal(selectedRoot.result.files[0], '/package.json');
});

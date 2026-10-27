import { promises as fs, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCliGitExtension, hasGitCli } from './gitCli';
import {
  FileType,
  type HostFileStat,
  type HostFolder,
  type HostInputBoxOptions,
  type HostPosition,
  type HostRange,
  type HostTextDocument,
  type HostUri,
  type HostWorkspaceEdit,
  type WorkspaceHost,
} from './host';

/**
 * 本机文件系统宿主（桌面端「书斋」）：没有编辑器，文档就是磁盘文件。
 * - 打开过的文档留在 textDocuments 里，每次取用前与磁盘核对，内容变了就换新内容并递增版本号；
 * - 版本号按文件路径单调递增，同一内容在多次请求间保持不变，供服务端做版本校验；
 * - applyEdit 先改内存中的文档（标记未保存），save 再写盘；UTF-8 BOM 与原有换行原样保留。
 */

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
]);
const MAX_OPEN_DOCUMENTS = 200;
const BOM = '﻿';

export class NodeUri implements HostUri {
  readonly scheme = 'file';
  readonly authority = '';
  readonly fsPath: string;
  readonly path: string;

  constructor(fsPath: string) {
    this.fsPath = path.resolve(fsPath);
    const slashed = this.fsPath.split(path.sep).join('/');
    this.path = slashed.startsWith('/') ? slashed : `/${slashed}`;
  }

  toString(): string {
    return pathToFileURL(this.fsPath).href;
  }
}

export type NodeWorkspaceHostOptions = {
  /** 当前书斋（可多个根目录）；返回空数组表示尚未选择。 */
  folders(): Array<{ path: string; name?: string }>;
  /** 移到系统回收站（Electron 的 shell.trashItem）。 */
  trashItem(fsPath: string): Promise<void>;
  showWarningModal?(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  showInputBox?(options: HostInputBoxOptions): Promise<string | undefined>;
  configuration?(section: string, key: string): unknown;
  /** 是否用本机 git 命令提供 Git（默认 true；本机没有 git 时自动不提供）。 */
  git?: boolean;
};

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 13 && text.charCodeAt(index + 1) === 10) {
      starts.push(index + 2);
      index += 1;
    } else if (char === 10 || char === 13) {
      starts.push(index + 1);
    }
  }
  return starts;
}

function fsError(error: unknown): Error {
  const value = error as NodeJS.ErrnoException;
  if (value?.code === 'ENOENT' || value?.code === 'ENOTDIR') return Object.assign(new Error('File not found'), { code: 'FileNotFound' });
  if (value?.code === 'EEXIST') return Object.assign(new Error('File exists'), { code: 'FileExists' });
  if (value?.code === 'ENOTEMPTY') return Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
  return value instanceof Error ? value : new Error(String(error));
}

function decode(bytes: Buffer): { text: string; bom: boolean } {
  const text = bytes.toString('utf8');
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

class NodeTextDocument implements HostTextDocument {
  version: number;
  isDirty = false;
  isClosed = false;
  private starts: number[];

  constructor(
    readonly uri: NodeUri,
    public content: string,
    public bom: boolean,
    version: number,
    public diskHash: string,
    public diskStamp: string,
    private readonly onSaved: (document: NodeTextDocument, ok: boolean) => void,
  ) {
    this.version = version;
    this.starts = lineStarts(content);
  }

  setContent(content: string): void {
    this.content = content;
    this.starts = lineStarts(content);
  }

  get lineCount(): number {
    return this.starts.length;
  }

  offsetAt(position: HostPosition): number {
    const line = Math.max(0, Math.min(position.line, this.starts.length - 1));
    const lineEnd = line + 1 < this.starts.length ? this.starts[line + 1] : this.content.length;
    return Math.min(lineEnd, this.starts[line] + Math.max(0, position.character));
  }

  getText(range?: HostRange): string {
    if (!range) return this.content;
    return this.content.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  positionAt(offset: number): HostPosition {
    const clamped = Math.max(0, Math.min(offset, this.content.length));
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= clamped) low = middle;
      else high = middle - 1;
    }
    return { line: low, character: clamped - this.starts[low] };
  }

  lineAt(line: number): { range: HostRange } {
    const index = Math.max(0, Math.min(line, this.starts.length - 1));
    const start = this.starts[index];
    let end = index + 1 < this.starts.length ? this.starts[index + 1] : this.content.length;
    while (end > start && (this.content[end - 1] === '\n' || this.content[end - 1] === '\r')) end -= 1;
    return { range: { start: { line: index, character: 0 }, end: { line: index, character: end - start } } };
  }

  async save(): Promise<boolean> {
    if (this.isClosed) return false;
    const text = this.content;
    try {
      await fs.writeFile(this.uri.fsPath, (this.bom ? BOM : '') + text, 'utf8');
    } catch {
      // 写盘失败：丢弃内存中的修改并关闭文档，之后的读取重新以磁盘为准，不留下「看得见却没保存」的内容。
      this.isDirty = false;
      this.isClosed = true;
      this.onSaved(this, false);
      return false;
    }
    this.diskHash = contentKey(text, this.bom);
    this.diskStamp = stampOf(this.uri.fsPath);
    this.isDirty = false;
    this.onSaved(this, true);
    return true;
  }
}

function contentKey(text: string, bom: boolean): string {
  return `${bom ? 1 : 0}:${text.length}:${text}`;
}

/** 修改时间 + 大小；没变就不重新读盘。 */
function stampOf(fsPath: string): string {
  try {
    const stat = statSync(fsPath);
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : '';
  } catch {
    return '';
  }
}

type PendingCreate = { uri: HostUri; options?: { overwrite?: boolean; contents?: Uint8Array } };
type PendingReplace = { uri: HostUri; range: HostRange; newText: string };

class NodeWorkspaceEdit implements HostWorkspaceEdit {
  readonly creates: PendingCreate[] = [];
  readonly replaces: PendingReplace[] = [];
  replace(uri: HostUri, range: HostRange, newText: string): void {
    this.replaces.push({ uri, range, newText });
  }
  createFile(uri: HostUri, options?: { overwrite?: boolean; contents?: Uint8Array }): void {
    this.creates.push({ uri, options });
  }
}

export function createNodeWorkspaceHost(options: NodeWorkspaceHostOptions): WorkspaceHost {
  const documents = new Map<string, NodeTextDocument>();
  // 文件路径 → 最近一次的版本号与内容指纹；文档被移出缓存后再次打开仍沿用，避免版本号回退。
  const versions = new Map<string, { version: number; key: string }>();
  const keyOf = (uri: HostUri) => path.resolve(uri.fsPath).toLowerCase();
  let gitAvailable: boolean | undefined;
  let gitExtension: ReturnType<typeof createCliGitExtension> | undefined;

  const versionFor = (file: string, key: string): number => {
    const previous = versions.get(file);
    const version = !previous ? 1 : previous.key === key ? previous.version : previous.version + 1;
    versions.set(file, { version, key });
    return version;
  };

  /** 未保存的文档以内存为准；其余文档与磁盘核对，磁盘变了就更新内容与版本，文件没了就关闭。 */
  const syncWithDisk = (document: NodeTextDocument): void => {
    if (document.isClosed || document.isDirty) return;
    const stamp = stampOf(document.uri.fsPath);
    if (stamp && stamp === document.diskStamp) return;
    let bytes: Buffer;
    try {
      if (!stamp) throw new Error('not a file');
      bytes = readFileSync(document.uri.fsPath);
    } catch {
      document.isClosed = true;
      documents.delete(keyOf(document.uri));
      return;
    }
    document.diskStamp = stamp;
    const { text, bom } = decode(bytes);
    const key = contentKey(text, bom);
    if (key === document.diskHash && text === document.content) return;
    document.setContent(text);
    document.bom = bom;
    document.diskHash = key;
    document.version = versionFor(keyOf(document.uri), key);
  };

  // 保存不改变版本号，只把记录的指纹换成磁盘内容，之后重新打开仍是同一版本。
  const markSaved = (document: NodeTextDocument, ok: boolean) => {
    if (ok) versions.set(keyOf(document.uri), { version: document.version, key: document.diskHash });
    else if (documents.get(keyOf(document.uri)) === document) documents.delete(keyOf(document.uri));
  };

  const remember = (document: NodeTextDocument) => {
    const key = keyOf(document.uri);
    documents.delete(key);
    documents.set(key, document);
    while (documents.size > MAX_OPEN_DOCUMENTS) {
      const oldest = [...documents.entries()].find(([, value]) => !value.isDirty);
      if (!oldest) break;
      oldest[1].isClosed = true;
      documents.delete(oldest[0]);
    }
  };

  const closeUnder = (fsPath: string) => {
    const prefix = path.resolve(fsPath).toLowerCase();
    for (const [key, document] of [...documents.entries()]) {
      if (key === prefix || key.startsWith(prefix + path.sep)) {
        document.isClosed = true;
        documents.delete(key);
      }
    }
  };

  return {
    workspaceFolders(): HostFolder[] {
      return options.folders().map((folder, index) => ({
        uri: new NodeUri(folder.path),
        name: folder.name ?? path.basename(path.resolve(folder.path)),
        index,
      }));
    },
    joinPath: (base, ...segments) => new NodeUri(path.join(base.fsPath, ...segments)),
    fs: {
      async stat(uri): Promise<HostFileStat> {
        try {
          const link = await fs.lstat(uri.fsPath);
          const target = link.isSymbolicLink() ? await fs.stat(uri.fsPath).catch(() => link) : link;
          const type = (target.isFile() ? FileType.File : 0) | (target.isDirectory() ? FileType.Directory : 0)
            | (link.isSymbolicLink() ? FileType.SymbolicLink : 0);
          return { type, ctime: link.ctimeMs, mtime: link.mtimeMs, size: target.size };
        } catch (error) {
          throw fsError(error);
        }
      },
      async readFile(uri) {
        try { return await fs.readFile(uri.fsPath); } catch (error) { throw fsError(error); }
      },
      async readDirectory(uri) {
        try {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry): [string, number] => [entry.name,
            entry.isSymbolicLink() ? FileType.SymbolicLink : entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown]);
        } catch (error) {
          throw fsError(error);
        }
      },
      async createDirectory(uri) {
        try { await fs.mkdir(uri.fsPath, { recursive: true }); } catch (error) { throw fsError(error); }
      },
      async delete(uri, deleteOptions) {
        try {
          if (deleteOptions.useTrash) {
            await fs.lstat(uri.fsPath);
            await options.trashItem(uri.fsPath);
          } else {
            await fs.rm(uri.fsPath, { recursive: deleteOptions.recursive });
          }
        } catch (error) {
          throw fsError(error);
        } finally {
          closeUnder(uri.fsPath);
        }
      },
    },
    textDocuments() {
      for (const document of [...documents.values()]) syncWithDisk(document);
      return [...documents.values()];
    },
    activeDocument: () => undefined,
    async openTextDocument(uri) {
      const key = keyOf(uri);
      const existing = documents.get(key);
      if (existing) {
        syncWithDisk(existing);
        if (!existing.isClosed) {
          remember(existing);
          return existing;
        }
      }
      let bytes: Buffer;
      try {
        if (!(await fs.stat(uri.fsPath)).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
        bytes = await fs.readFile(uri.fsPath);
      } catch (error) {
        throw fsError(error);
      }
      const { text, bom } = decode(bytes);
      const diskKey = contentKey(text, bom);
      const document = new NodeTextDocument(new NodeUri(uri.fsPath), text, bom, versionFor(key, diskKey), diskKey,
        stampOf(uri.fsPath), markSaved);
      remember(document);
      return document;
    },
    createEdit: () => new NodeWorkspaceEdit(),
    async applyEdit(edit) {
      const pending = edit as NodeWorkspaceEdit;
      for (const { uri, options: createOptions } of pending.creates) {
        try {
          await fs.writeFile(uri.fsPath, createOptions?.contents ?? new Uint8Array(),
            { flag: createOptions?.overwrite ? 'w' : fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY });
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
          throw fsError(error);
        }
      }
      // 全部替换先在副本上算好，任何一个文档不可用就整体放弃，不留半套修改。
      const byDocument = new Map<NodeTextDocument, PendingReplace[]>();
      for (const item of pending.replaces) {
        const document = documents.get(keyOf(item.uri));
        if (!document || document.isClosed) return false;
        byDocument.set(document, [...(byDocument.get(document) ?? []), item]);
      }
      const results = new Map<NodeTextDocument, string>();
      for (const [document, items] of byDocument) {
        const ordered = items.map((item) => ({
          start: document.offsetAt(item.range.start),
          end: document.offsetAt(item.range.end),
          text: item.newText,
        })).sort((left, right) => right.start - left.start);
        let content = document.content;
        for (const item of ordered) content = content.slice(0, item.start) + item.text + content.slice(item.end);
        results.set(document, content);
      }
      for (const [document, content] of results) {
        document.setContent(content);
        document.isDirty = true;
        document.version = versionFor(keyOf(document.uri), `dirty:${contentKey(content, document.bom)}`);
      }
      return true;
    },
    position: (line, character) => ({ line, character }),
    range: (start, end) => ({ start, end }),
    async findFiles(root, _include, _exclude, maxResults) {
      // 只用于全工作区扫描（include 为 **/*）：跳过与 VS Code 排除规则相同的目录，不跟随符号链接。
      const found: HostUri[] = [];
      const pendingDirs = [root.uri.fsPath];
      while (pendingDirs.length && found.length < maxResults) {
        const current = pendingDirs.shift()!;
        let entries: Array<import('node:fs').Dirent>;
        try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (found.length >= maxResults) break;
          if (entry.isSymbolicLink()) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) pendingDirs.push(full);
          } else if (entry.isFile()) {
            found.push(new NodeUri(full));
          }
        }
      }
      return found;
    },
    // 书斋由用户在系统对话框中亲自选择，视为已信任。
    isTrusted: () => true,
    configuration: (section, key) => options.configuration?.(section, key),
    showWarningModal: (message, detail, actions) => options.showWarningModal?.(message, detail, actions) ?? Promise.resolve(undefined),
    showInputBox: (inputOptions) => options.showInputBox?.(inputOptions) ?? Promise.resolve(undefined),
    // 没有 VS Code：Git 用本机 git 命令实现同一套接口；其他扩展（如 ms-python.python）不提供
    getExtension: <T>(id: string) => {
      if (id !== 'vscode.git' || options.git === false) return undefined;
      gitAvailable ??= hasGitCli();
      if (!gitAvailable) return undefined;
      gitExtension ??= createCliGitExtension((fsPath) => new NodeUri(fsPath));
      const exports = gitExtension as unknown as T;
      return { isActive: true, exports, activate: () => Promise.resolve(exports) };
    },
  };
}

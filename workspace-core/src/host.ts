/**
 * 工作区宿主接口：公共工作区核心（文件读写、补丁、撤销、工具链）只通过这里访问宿主。
 * VS Code 插件用 VS Code API 实现；桌面端（书斋）用本机文件系统实现。
 * 形状与 VS Code 对应 API 保持一致，VS Code 适配器可以直接返回原生对象。
 */

export interface HostUri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly fsPath: string;
  toString(): string;
}

/** 与 vscode.FileType 数值一致，可按位判断。 */
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

export interface HostFileStat {
  readonly type: number;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

export interface HostFolder {
  readonly uri: HostUri;
  readonly name: string;
  readonly index: number;
}

export interface HostPosition {
  readonly line: number;
  readonly character: number;
}

export interface HostRange {
  readonly start: HostPosition;
  readonly end: HostPosition;
}

/** 宿主里的文本文档；isDirty 表示编辑器中有未保存的修改（没有编辑器的宿主恒为 false）。 */
export interface HostTextDocument {
  readonly uri: HostUri;
  readonly version: number;
  readonly isDirty: boolean;
  readonly isClosed: boolean;
  readonly lineCount: number;
  getText(range?: HostRange): string;
  positionAt(offset: number): HostPosition;
  lineAt(line: number): { readonly range: HostRange };
  save(): PromiseLike<boolean>;
}

/** 一次批量修改；由 createEdit 创建、applyEdit 原子应用。 */
export interface HostWorkspaceEdit {
  replace(uri: HostUri, range: HostRange, newText: string): void;
  createFile(uri: HostUri, options?: { overwrite?: boolean; contents?: Uint8Array }): void;
}

export interface HostExtension<T> {
  readonly isActive: boolean;
  readonly exports: T;
  activate(): PromiseLike<T>;
}

export interface HostInputBoxOptions {
  title?: string;
  value?: string;
  prompt?: string;
  ignoreFocusOut?: boolean;
  validateInput?: (text: string) => string | undefined;
}

export interface WorkspaceHost {
  /** 当前连接的工作区根目录；未打开时为空或 undefined。 */
  workspaceFolders(): readonly HostFolder[] | undefined;
  joinPath(base: HostUri, ...segments: string[]): HostUri;
  readonly fs: {
    stat(uri: HostUri): PromiseLike<HostFileStat>;
    readFile(uri: HostUri): PromiseLike<Uint8Array>;
    readDirectory(uri: HostUri): PromiseLike<[string, number][]>;
    /** mkdirp 语义。 */
    createDirectory(uri: HostUri): PromiseLike<void>;
    delete(uri: HostUri, options: { recursive: boolean; useTrash: boolean }): PromiseLike<void>;
  };
  /** 宿主当前打开的文档（含未保存的编辑）；每次调用都取最新列表。 */
  textDocuments(): readonly HostTextDocument[];
  activeDocument(): HostTextDocument | undefined;
  openTextDocument(uri: HostUri): PromiseLike<HostTextDocument>;
  createEdit(): HostWorkspaceEdit;
  applyEdit(edit: HostWorkspaceEdit): PromiseLike<boolean>;
  position(line: number, character: number): HostPosition;
  range(start: HostPosition, end: HostPosition): HostRange;
  /** 在 root 内按 glob 查找文件（include 相对 root，exclude 为排除 glob）。 */
  findFiles(root: HostFolder, include: string, exclude: string, maxResults: number): PromiseLike<HostUri[]>;
  /** 工作区是否受信任（不受信任时工具链拒绝执行命令）。 */
  isTrusted(): boolean;
  /** 读取宿主设置（如 gor.toolchain.allowlist）；没有时返回 undefined。 */
  configuration(section: string, key: string): unknown;
  /** 原生模态确认框；返回所选按钮文字，关闭则 undefined。 */
  showWarningModal(message: string, detail: string, actions: string[]): PromiseLike<string | undefined>;
  showInputBox(options: HostInputBoxOptions): PromiseLike<string | undefined>;
  /** 宿主提供的扩展 API（VS Code 的 vscode.git、ms-python.python）；没有时 undefined。 */
  getExtension<T>(id: string): HostExtension<T> | undefined;
}

let current: WorkspaceHost | undefined;

/** 由插件或桌面端在启动时调用一次。 */
export function setWorkspaceHost(next: WorkspaceHost): void {
  current = next;
}

export function host(): WorkspaceHost {
  if (!current) throw new Error('Gor workspace host is not configured.');
  return current;
}

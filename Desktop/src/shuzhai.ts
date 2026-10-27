/**
 * 书斋（桌面端本地模式）：把用户选定的本机文件夹登记为 Gor 工作区，Agent 经公共工作区核心直接读写其中的文件。
 * 本模块不依赖 Electron（对话框、回收站、确认框都由调用方注入），可离线测试。
 * - 新文件夹只能经系统对话框选择；页面只能重新打开「最近的书斋」里已选过的文件夹；
 * - 状态（当前书斋与最近列表）存放在用户数据目录的 shuzhai.json；
 * - 打开书斋后用 /ws/vscode 以 desktop 身份登记，断线自动重连；换书斋会重新登记。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configureToolchainUi,
  createNodeWorkspaceHost,
  externalDenyReason,
  GorConnection,
  NodeUri,
  nativeUi,
  setWorkspaceHost,
  WorkspaceRequestHandler,
  type GorConnectionStatus,
  type HostInputBoxOptions,
} from '@gor/workspace-core';
import { ToolchainRelay } from './toolchainRelay';

export const MAX_RECENT = 8;

export type ShuzhaiFolder = { path: string; name: string };
export type ShuzhaiRecent = ShuzhaiFolder & { openedAt: number };
export type ShuzhaiConnection = 'idle' | GorConnectionStatus;
export type ShuzhaiState = {
  folder: ShuzhaiFolder | null;
  recent: ShuzhaiRecent[];
  connection: ShuzhaiConnection;
  workspaceId: string | null;
};
export type ShuzhaiOpenResult = { ok: true; state: ShuzhaiState } | { ok: false; reason: string; state: ShuzhaiState };

type StoredState = { current?: string; recent?: Array<{ path?: unknown; name?: unknown; openedAt?: unknown }> };

export type ShuzhaiDeps = {
  /** shuzhai.json 的完整路径。 */
  storePath: string;
  /** Gor 后端地址（http/https），连接 ws(s)://…/ws/vscode。 */
  apiBase: string;
  /** 弹出系统「选择文件夹」对话框；取消返回 undefined。 */
  chooseFolder(): Promise<string | undefined>;
  /** 弹出系统「新建项目」对话框，返回新文件夹的完整路径；取消返回 undefined。 */
  chooseNewProjectPath?(): Promise<string | undefined>;
  trashItem(fsPath: string): Promise<void>;
  showWarningModal(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  showInputBox?(options: HostInputBoxOptions): Promise<string | undefined>;
  revealPath(fsPath: string): void;
  onState(state: ShuzhaiState): void;
  /** 发给聊天页的施行消息（gor.toolchain）；没有可用窗口时返回 false，审阅退回系统确认框。 */
  sendToolchain?(message: unknown): boolean;
  /** 打开常驻进程打印的本机地址。 */
  openExternal?(url: string): void;
  log(message: string): void;
  /** 测试用：替换连接实现。 */
  createConnection?: typeof createConnection;
};

/** http://host:3001 → ws://host:3001/ws/vscode；https → wss。 */
export function workspaceSocketUrl(apiBase: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws/vscode';
  url.search = '';
  url.hash = '';
  return url.toString();
}

const samePath = (left: string, right: string) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

/** 校验并规范化要设为书斋的文件夹；不合适时返回原因。 */
export async function validateFolder(value: unknown): Promise<{ ok: true; folder: ShuzhaiFolder } | { ok: false; reason: string }> {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value.trim())) {
    return { ok: false, reason: '请选择本机上的一个文件夹。' };
  }
  let real: string;
  try {
    real = await fs.realpath(path.resolve(value.trim()));
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, reason: '所选路径不是文件夹。' };
  } catch {
    return { ok: false, reason: '文件夹不存在或无法访问。' };
  }
  if (path.parse(real).root === real || samePath(real, path.parse(real).root)) {
    return { ok: false, reason: '不能把整个磁盘设为书斋，请选择具体的项目文件夹。' };
  }
  if (samePath(real, os.homedir())) {
    return { ok: false, reason: '不能把整个用户目录设为书斋，请选择具体的项目文件夹。' };
  }
  const denied = externalDenyReason(real);
  if (denied) return { ok: false, reason: `${denied.replace(/不允许读取。?$/, '')}不能设为书斋。` };
  return { ok: true, folder: { path: real, name: path.basename(real) } };
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

export function addRecent(recent: ShuzhaiRecent[], folder: ShuzhaiFolder, now = Date.now()): ShuzhaiRecent[] {
  return [{ ...folder, openedAt: now }, ...recent.filter((item) => !samePath(item.path, folder.path))].slice(0, MAX_RECENT);
}

async function readStore(storePath: string): Promise<{ current?: string; recent: ShuzhaiRecent[] }> {
  let raw: StoredState;
  try {
    raw = JSON.parse(await fs.readFile(storePath, 'utf8')) as StoredState;
  } catch {
    return { recent: [] };
  }
  const recent: ShuzhaiRecent[] = [];
  for (const item of Array.isArray(raw?.recent) ? raw.recent : []) {
    if (typeof item?.path !== 'string') continue;
    const checked = await validateFolder(item.path);
    if (!checked.ok || recent.some((existing) => samePath(existing.path, checked.folder.path))) continue;
    recent.push({ ...checked.folder, openedAt: typeof item.openedAt === 'number' ? item.openedAt : 0 });
    if (recent.length >= MAX_RECENT) break;
  }
  return { current: typeof raw?.current === 'string' ? raw.current : undefined, recent };
}

function createConnection(...args: ConstructorParameters<typeof GorConnection>): Pick<GorConnection, 'connect' | 'dispose' | 'workspaceId'> {
  return new GorConnection(...args);
}

export class ShuzhaiService {
  private folder: ShuzhaiFolder | null = null;
  private recent: ShuzhaiRecent[] = [];
  private connectionStatus: ShuzhaiConnection = 'idle';
  private connection: Pick<GorConnection, 'connect' | 'dispose' | 'workspaceId'> | undefined;
  private readonly handler: WorkspaceRequestHandler;
  private readonly logger: { appendLine(text: string): void };
  readonly toolchain: ToolchainRelay;

  constructor(private readonly deps: ShuzhaiDeps) {
    this.logger = { appendLine: (text) => deps.log(text) };
    this.handler = new WorkspaceRequestHandler(this.logger);
    setWorkspaceHost(createNodeWorkspaceHost({
      folders: () => (this.folder ? [this.folder] : []),
      trashItem: deps.trashItem,
      showWarningModal: deps.showWarningModal,
      showInputBox: deps.showInputBox,
    }));
    // 删除确认、命令审阅优先显示为聊天页里的施行卡片；页面没能展示（窗口未就绪、在云笺模式等）时退回系统确认框。
    this.toolchain = new ToolchainRelay((message) => deps.sendToolchain?.(message) ?? false, (url) => deps.openExternal?.(url));
    configureToolchainUi({
      requestApproval: async (request, signal) =>
        (await this.toolchain.requestApproval(request, signal)) ?? nativeUi.requestApproval(request, signal),
      update: (update) => this.toolchain.update(update),
      output: (text) => deps.log(text),
    });
  }

  get state(): ShuzhaiState {
    return {
      folder: this.folder ? { ...this.folder } : null,
      recent: this.recent.map((item) => ({ ...item })),
      connection: this.connectionStatus,
      workspaceId: this.connection?.workspaceId ?? null,
    };
  }

  /** 启动时调用：读入最近列表，上次的书斋仍然存在就重新打开并登记。 */
  async restore(): Promise<ShuzhaiState> {
    const stored = await readStore(this.deps.storePath);
    this.recent = stored.recent;
    if (stored.current) {
      const checked = await validateFolder(stored.current);
      if (checked.ok) await this.open(checked.folder, false);
    }
    this.emit();
    return this.state;
  }

  /** 弹出系统对话框选择新的书斋。 */
  async pickFolder(): Promise<ShuzhaiOpenResult> {
    const chosen = await this.deps.chooseFolder();
    if (!chosen) return { ok: false, reason: 'cancelled', state: this.state };
    const checked = await validateFolder(chosen);
    if (!checked.ok) return { ok: false, reason: checked.reason, state: this.state };
    await this.open(checked.folder);
    return { ok: true, state: this.state };
  }

  /** 新建空白项目：经系统对话框选定位置与名称，建好空文件夹后设为书斋。已存在的非空文件夹不覆盖。 */
  async createProject(): Promise<ShuzhaiOpenResult> {
    const chosen = await this.deps.chooseNewProjectPath?.();
    if (!chosen) return { ok: false, reason: 'cancelled', state: this.state };
    const target = path.resolve(chosen);
    if (!(await isDirectory(path.dirname(target)))) {
      return { ok: false, reason: '新项目所在的文件夹不存在。', state: this.state };
    }
    try {
      await fs.mkdir(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const empty = code === 'EEXIST' && (await isDirectory(target)) && (await fs.readdir(target)).length === 0;
      if (!empty) {
        return { ok: false, reason: code === 'EEXIST' ? '同名文件夹已存在且不为空，请换一个名称。' : '无法创建项目文件夹。', state: this.state };
      }
    }
    const checked = await validateFolder(target);
    if (!checked.ok) return { ok: false, reason: checked.reason, state: this.state };
    await this.open(checked.folder);
    return { ok: true, state: this.state };
  }

  /** 拖入窗口的文件夹：路径由 preload 从用户拖入的文件对象取得（页面无法伪造），校验后设为书斋。 */
  async openDropped(value: unknown): Promise<ShuzhaiOpenResult> {
    const checked = await validateFolder(value);
    if (!checked.ok) return { ok: false, reason: checked.reason, state: this.state };
    await this.open(checked.folder);
    return { ok: true, state: this.state };
  }

  /** 重新打开最近列表里的书斋；不在列表里的路径一律拒绝（新文件夹只能经系统对话框选择）。 */
  async openRecent(value: unknown): Promise<ShuzhaiOpenResult> {
    const known = typeof value === 'string' ? this.recent.find((item) => samePath(item.path, value)) : undefined;
    if (!known) return { ok: false, reason: '只能打开最近用过的书斋，新文件夹请用「打开文件夹」选择。', state: this.state };
    const checked = await validateFolder(known.path);
    if (!checked.ok) {
      this.recent = this.recent.filter((item) => item !== known);
      await this.save();
      this.emit();
      return { ok: false, reason: checked.reason, state: this.state };
    }
    await this.open(checked.folder);
    return { ok: true, state: this.state };
  }

  /** 收起书斋：断开登记，不删除任何文件，最近列表保留。 */
  async close(): Promise<ShuzhaiState> {
    this.disconnect();
    this.folder = null;
    await this.save();
    this.emit();
    return this.state;
  }

  reveal(): boolean {
    if (!this.folder) return false;
    this.deps.revealPath(this.folder.path);
    return true;
  }

  dispose(): void {
    this.toolchain.releaseAll();
    this.disconnect();
  }

  private async open(folder: ShuzhaiFolder, persist = true): Promise<void> {
    this.disconnect();
    this.folder = folder;
    this.recent = addRecent(this.recent, folder);
    if (persist) await this.save();
    this.deps.log(`[Gor 书斋] 打开 ${folder.path}`);
    const make = this.deps.createConnection ?? createConnection;
    const connection = make(workspaceSocketUrl(this.deps.apiBase), this.logger, (status) => {
      if (this.connection !== connection) return;
      this.connectionStatus = status;
      this.emit();
    }, (request, workspaceId, send) => {
      if (this.connection !== connection) return;
      void this.handler.handle(request, workspaceId, send);
    }, () => ({
      type: 'workspace_connected',
      client: 'desktop',
      workspaceName: folder.name,
      workspaceFolders: [{ id: 'root-1', name: folder.name, uri: new NodeUri(folder.path).toString() }],
    }));
    this.connection = connection;
    this.connectionStatus = 'connecting';
    this.emit();
    void connection.connect().catch(() => {
      // 连接失败由 GorConnection 记录并按退避间隔重连，状态经 onState 通知页面。
    });
  }

  private disconnect(): void {
    const previous = this.connection;
    this.connection = undefined;
    this.connectionStatus = 'idle';
    previous?.dispose();
  }

  private async save(): Promise<void> {
    const data: StoredState = {
      ...(this.folder ? { current: this.folder.path } : {}),
      recent: this.recent.map(({ path: folderPath, name, openedAt }) => ({ path: folderPath, name, openedAt })),
    };
    try {
      await fs.mkdir(path.dirname(this.deps.storePath), { recursive: true });
      await fs.writeFile(this.deps.storePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      this.deps.log(`[Gor 书斋] 无法保存书斋列表：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emit(): void {
    this.deps.onState(this.state);
  }
}

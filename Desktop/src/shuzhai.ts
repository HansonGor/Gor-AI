/**
 * 书斋（桌面端本地模式）：把用户选定的本机文件夹登记为 Gor 工作区，Agent 经公共工作区核心直接读写其中的文件。
 * 本模块不依赖 Electron（对话框、回收站、确认框都由调用方注入），可离线测试。
 * - 新文件夹只能经系统对话框选择；页面只能重新打开「最近的书斋」里已选过的文件夹；
 * - 状态（当前书斋与最近列表）存放在用户数据目录的 shuzhai.json；
 * - 打开书斋后用 /ws/vscode 以 desktop 身份登记，断线自动重连；换书斋会重新登记。
 * - 遥斋：登记时带上登录凭证、本机设备与「允许网页遥控」开关（默认关）；打开后施行审阅同时转给同账号的网页，
 *   网页的回答经后端转回，与本机卡片先到先得；关掉开关时未回答的审阅一律拒绝。
 */
import { randomUUID } from 'node:crypto';
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
import { APPROVAL_SHOWN_TIMEOUT_MS, ToolchainRelay } from './toolchainRelay';

export const MAX_RECENT = 8;

export type ShuzhaiFolder = { path: string; name: string };
export type ShuzhaiRecent = ShuzhaiFolder & { openedAt: number };
export type ShuzhaiConnection = 'idle' | GorConnectionStatus;
/** 正在遥控本书斋的网页（PC / 手机浏览器）。 */
export type ShuzhaiRemoteClient = { id: string; label: string; lastActive: number };
export type ShuzhaiRemote = {
  /** 「允许网页遥控此书斋」开关，存在 shuzhai.json，默认关。 */
  allowed: boolean;
  /** 服务端已把书斋绑定到账号（已登录且已登记）；未登录时只能本机使用。 */
  available: boolean;
  clients: ShuzhaiRemoteClient[];
};
export type ShuzhaiState = {
  folder: ShuzhaiFolder | null;
  recent: ShuzhaiRecent[];
  connection: ShuzhaiConnection;
  workspaceId: string | null;
  remote: ShuzhaiRemote;
};
export type ShuzhaiOpenResult = { ok: true; state: ShuzhaiState } | { ok: false; reason: string; state: ShuzhaiState };

type StoredState = {
  current?: string;
  recent?: Array<{ path?: unknown; name?: unknown; openedAt?: unknown }>;
  deviceId?: unknown;
  remoteAllowed?: unknown;
};
/** 网页可以转回本机的施行消息；打开本机地址只接受本机页面。 */
const REMOTE_PAGE_MESSAGES = new Set(['gor.toolchainApprovalShown', 'gor.toolchainApprovalAnswer', 'gor.toolchainCancel']);
/** 转给遥斋网页时经后端往返，等卡片展示的时间放宽。 */
export const REMOTE_SHOWN_TIMEOUT_MS = 4000;

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
  /** 当前登录凭证（遥斋据此把书斋绑定到账号）；未登录返回空。 */
  getAuthToken?(): string | null | undefined;
  /** 本机名称，显示在网页的遥斋列表里。 */
  deviceName?: string;
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

async function readStore(storePath: string): Promise<{ current?: string; recent: ShuzhaiRecent[]; deviceId?: string; remoteAllowed: boolean }> {
  let raw: StoredState;
  try {
    raw = JSON.parse(await fs.readFile(storePath, 'utf8')) as StoredState;
  } catch {
    return { recent: [], remoteAllowed: false };
  }
  const recent: ShuzhaiRecent[] = [];
  for (const item of Array.isArray(raw?.recent) ? raw.recent : []) {
    if (typeof item?.path !== 'string') continue;
    const checked = await validateFolder(item.path);
    if (!checked.ok || recent.some((existing) => samePath(existing.path, checked.folder.path))) continue;
    recent.push({ ...checked.folder, openedAt: typeof item.openedAt === 'number' ? item.openedAt : 0 });
    if (recent.length >= MAX_RECENT) break;
  }
  return {
    current: typeof raw?.current === 'string' ? raw.current : undefined,
    recent,
    deviceId: typeof raw?.deviceId === 'string' && /^[\w-]{8,80}$/.test(raw.deviceId) ? raw.deviceId : undefined,
    remoteAllowed: raw?.remoteAllowed === true,
  };
}

type ShuzhaiConnectionHandle = Pick<GorConnection, 'connect' | 'dispose' | 'workspaceId' | 'send' | 'reannounce'>;

function createConnection(...args: ConstructorParameters<typeof GorConnection>): ShuzhaiConnectionHandle {
  return new GorConnection(...args);
}

function remoteClients(value: unknown): ShuzhaiRemoteClient[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => item && typeof item === 'object' && typeof item.id === 'string'
    ? [{ id: item.id.slice(0, 80), label: typeof item.label === 'string' ? item.label.slice(0, 80) : '网页', lastActive: Number(item.lastActive) || 0 }]
    : []).slice(0, 20);
}

export class ShuzhaiService {
  private folder: ShuzhaiFolder | null = null;
  private recent: ShuzhaiRecent[] = [];
  private connectionStatus: ShuzhaiConnection = 'idle';
  private connection: ShuzhaiConnectionHandle | undefined;
  private deviceId = '';
  private remoteAllowed = false;
  private remoteAvailable = false;
  private remoteClientList: ShuzhaiRemoteClient[] = [];
  private announcedToken: string | null = null;
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
    // 遥斋打开且有网页在遥控时，同一条消息也转给网页（经后端），两边哪边先答以哪边为准。
    this.toolchain = new ToolchainRelay((message) => {
      const local = deps.sendToolchain?.(message) ?? false;
      const remote = this.remoteReady() && (this.connection?.send({ type: 'remote_toolchain', message }) ?? false);
      return local || remote;
    }, (url) => deps.openExternal?.(url), undefined, () => (this.remoteReady() ? REMOTE_SHOWN_TIMEOUT_MS : APPROVAL_SHOWN_TIMEOUT_MS));
    configureToolchainUi({
      // 遥斋开启时审阅一律留在聊天卡片里（本机书斋页面或任一遥控网页先答为准），到期自动搁置，不再弹系统确认框
      requestApproval: async (request, signal) =>
        (await this.toolchain.requestApproval(request, signal, this.remoteReady())) ?? nativeUi.requestApproval(request, signal),
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
      remote: { allowed: this.remoteAllowed, available: this.remoteAvailable, clients: this.remoteClientList.map((item) => ({ ...item })) },
    };
  }

  /** 打开或关闭「允许网页遥控此书斋」：记住选择并重新登记；关闭时未回答的审阅一律拒绝。 */
  async setRemoteAllowed(value: unknown): Promise<ShuzhaiState> {
    const allowed = value === true;
    if (allowed === this.remoteAllowed) return this.state;
    this.remoteAllowed = allowed;
    if (!allowed) {
      this.remoteClientList = [];
      this.toolchain.rejectAll();
    }
    await this.save();
    this.connection?.reannounce();
    this.emit();
    return this.state;
  }

  /** 断开某台正在遥控的设备：本次开关期间它不能再遥控（关掉再打开开关即恢复）。 */
  disconnectRemote(clientId: unknown): ShuzhaiState {
    if (typeof clientId === 'string' && this.remoteClientList.some((item) => item.id === clientId)) {
      this.connection?.send({ type: 'remote_disconnect', clientId });
      this.remoteClientList = this.remoteClientList.filter((item) => item.id !== clientId);
      this.emit();
    }
    return this.state;
  }

  /** 登录或退出后调用：凭证变了就重新登记，让服务端更新书斋的账号绑定。 */
  refreshAuth(): void {
    if ((this.deps.getAuthToken?.() ?? null) !== this.announcedToken) this.connection?.reannounce();
  }

  /** 开关已开且服务端已绑定账号：审阅转给网页（即使此刻没有网页在线，稍后打开的设备也能补上卡片）。 */
  private remoteReady(): boolean {
    return this.remoteAllowed && this.remoteAvailable;
  }

  private handleServerMessage(message: Record<string, unknown>): void {
    switch (message.type) {
      case 'remote_status':
        this.remoteAvailable = message.available === true;
        this.remoteClientList = this.remoteAvailable ? remoteClients(message.clients) : [];
        // 重新登记（断线重连、后端重启）后，把仍在等回答的审阅再转一遍，服务端据此给网页补上卡片
        if (this.remoteReady()) {
          for (const request of this.toolchain.pendingRequests()) this.connection?.send({ type: 'remote_toolchain', message: { type: 'gor.toolchain', kind: 'approval', request } });
        }
        this.emit();
        break;
      case 'remote_clients':
        this.remoteClientList = remoteClients(message.clients);
        this.emit();
        break;
      case 'remote_page_message': {
        const page = message.message as Record<string, unknown> | undefined;
        // 开关已关时不接受网页的回答（服务端也会拒绝，这里再挡一次）
        if (this.remoteAllowed && page && REMOTE_PAGE_MESSAGES.has(page.type as string)) this.toolchain.handlePageMessage(page);
        break;
      }
      default:
        break;
    }
  }

  /** 启动时调用：读入最近列表，上次的书斋仍然存在就重新打开并登记。 */
  async restore(): Promise<ShuzhaiState> {
    const stored = await readStore(this.deps.storePath);
    this.recent = stored.recent;
    this.remoteAllowed = stored.remoteAllowed;
    this.deviceId = stored.deviceId ?? '';
    if (stored.current) {
      const checked = await validateFolder(stored.current);
      if (checked.ok) await this.open(checked.folder, false);
    }
    // 旧版本的 shuzhai.json 没有设备标识：重开书斋之后再保存，不能先存把「当前书斋」丢掉
    if (!stored.deviceId) await this.save();
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
      // 断线期间不算绑定，遥控设备列表等重新登记后由服务端给出
      if (status !== 'connected') {
        this.remoteAvailable = false;
        this.remoteClientList = [];
      }
      this.emit();
    }, (request, workspaceId, send) => {
      if (this.connection !== connection) return;
      void this.handler.handle(request, workspaceId, send);
    }, () => {
      this.announcedToken = this.deps.getAuthToken?.() || null;
      return {
        type: 'workspace_connected',
        client: 'desktop',
        workspaceName: folder.name,
        workspaceFolders: [{ id: 'root-1', name: folder.name, uri: new NodeUri(folder.path).toString() }],
        // 遥斋：凭证只用于服务端绑定账号，不记日志、不回传
        ...(this.announcedToken ? { authToken: this.announcedToken } : {}),
        deviceId: this.ensureDeviceId(),
        deviceName: this.deps.deviceName ?? os.hostname(),
        folderPath: folder.path,
        remoteAllowed: this.remoteAllowed,
      };
    }, (message) => {
      if (this.connection === connection) this.handleServerMessage(message);
    });
    this.connection = connection;
    this.connectionStatus = 'connecting';
    this.emit();
    void connection.connect().catch(() => {
      // 连接失败由 GorConnection 记录并按退避间隔重连，状态经 onState 通知页面。
    });
  }

  private ensureDeviceId(): string {
    if (!this.deviceId) this.deviceId = randomUUID();
    return this.deviceId;
  }

  private disconnect(): void {
    const previous = this.connection;
    this.connection = undefined;
    this.connectionStatus = 'idle';
    this.remoteAvailable = false;
    this.remoteClientList = [];
    previous?.dispose();
  }

  private async save(): Promise<void> {
    const data: StoredState = {
      ...(this.folder ? { current: this.folder.path } : {}),
      recent: this.recent.map(({ path: folderPath, name, openedAt }) => ({ path: folderPath, name, openedAt })),
      deviceId: this.ensureDeviceId(),
      remoteAllowed: this.remoteAllowed,
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

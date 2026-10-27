import WebSocket, { RawData } from 'ws';
import type { WorkspaceLog } from './requestHandler';

export type GorConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** 向 Gor Server 登记的工作区描述；client 区分 VS Code 插件与桌面端（书斋）。 */
export type WorkspaceConnectedMessage = {
  type: 'workspace_connected';
  client: 'vscode' | 'desktop';
  workspaceName: string;
  workspaceFolders: Array<{ id: string; name: string; uri: string }>;
  /** 桌面端书斋附带：登录凭证、本机设备与「允许网页遥控」开关（遥斋）。 */
  [extra: string]: unknown;
};

type WorkspaceRegisteredMessage = {
  type: 'workspace_registered';
  workspaceId: string;
};

export type WorkspaceRequestMessage = {
  type: 'workspace_request';
  requestId: string;
  workspaceId: string;
  method: string;
  params?: Record<string, unknown>;
};

export type WorkspaceResponseMessage = {
  type: 'workspace_response';
  requestId: string;
  workspaceId: string;
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

/**
 * 与 Gor Server 的工作区连接（/ws/vscode）：连接后登记工作区，接收 workspace_request 并回传结果，
 * 断线按 1/2/4…30 秒退避重连。插件与桌面端共用，登记内容由 describeWorkspace 提供。
 */
export class GorConnection {
  private socket: WebSocket | undefined;
  private disposed = false;
  private status: GorConnectionStatus = 'disconnected';
  private registeredWorkspaceId: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private readonly workspaceWaiters = new Set<() => void>();

  constructor(
    private readonly serverUrl: string,
    private readonly output: WorkspaceLog,
    private readonly onStatusChange: (status: GorConnectionStatus, workspaceId?: string) => void,
    private readonly onWorkspaceRequest?: (
      request: WorkspaceRequestMessage,
      currentWorkspaceId: string | undefined,
      send: (response: WorkspaceResponseMessage) => boolean,
    ) => void,
    private readonly describeWorkspace: () => WorkspaceConnectedMessage = () => ({
      type: 'workspace_connected', client: 'vscode', workspaceName: '', workspaceFolders: [],
    }),
    /** 登记与工作区请求之外的服务端消息（桌面端遥斋用）。 */
    private readonly onServerMessage?: (message: { type?: unknown } & Record<string, unknown>) => void,
  ) {}

  get currentStatus(): GorConnectionStatus {
    return this.status;
  }

  get workspaceId(): string | undefined {
    return this.registeredWorkspaceId;
  }

  /** 工作区已登记就立即返回；正在（重新）连接时最多等 timeoutMs，超时返回 undefined。 */
  waitForWorkspace(timeoutMs: number): Promise<string | undefined> {
    if (this.registeredWorkspaceId || this.disposed) return Promise.resolve(this.registeredWorkspaceId);
    // 正在按退避间隔等下一次重连：有消息要发，就立即重连，不再干等退避时间。
    if (!this.socket && this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        // 失败时由连接错误处理安排下一次重连。
      });
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.workspaceWaiters.delete(done);
        resolve(this.registeredWorkspaceId);
      };
      const timer = setTimeout(done, timeoutMs);
      this.workspaceWaiters.add(done);
    });
  }

  /** 登记内容变了（登录状态、遥斋开关）：已连接时重新发送登记，服务端沿用同一个工作区 ID。 */
  reannounce(): boolean {
    return this.status === 'connected' ? this.send(this.createWorkspaceMessage()) : false;
  }

  notifyWorkspaceTreeChanged(root?: string): void {
    if (!this.registeredWorkspaceId) return;
    this.send({ type: 'workspace_tree_changed', root });
  }

  connect(): Promise<void> {
    if (this.status === 'connected') return Promise.resolve();
    if (this.socket?.readyState === WebSocket.CONNECTING) return Promise.resolve();

    this.disposed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.registeredWorkspaceId = undefined;
    this.setStatus('connecting');
    this.output.appendLine(`[Gor] Connecting to ${this.serverUrl}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.serverUrl);
      } catch (error) {
        const connectionError = error instanceof Error ? error : new Error(String(error));
        this.output.appendLine(`[Gor] Connection error: ${connectionError.message}`);
        this.setStatus('disconnected');
        settle(connectionError);
        this.scheduleReconnect();
        return;
      }

      this.socket = socket;
      socket.on('open', () => {
        if (this.disposed || this.socket !== socket) return;
        this.reconnectAttempt = 0;
        this.output.appendLine('[Gor] Connected');
        this.setStatus('connected');
        this.send(this.createWorkspaceMessage());
        settle();
      });

      socket.on('message', (data: RawData) => this.handleMessage(data));

      socket.on('error', (error: Error) => {
        if (this.disposed || this.socket !== socket) return;
        this.output.appendLine(`[Gor] Connection error: ${error.message}`);
        this.markDisconnected(socket);
        settle(error);
      });

      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.markDisconnected(socket);
        settle(new Error('Gor Server closed the WebSocket connection'));
      });
    });
  }

  send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    const socket = this.socket;
    socket.send(JSON.stringify(message), (error) => {
      if (error && !this.disposed) {
        this.output.appendLine(`[Gor] Connection error: ${error.message}`);
        this.markDisconnected(socket);
      }
    });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.terminate();
    }
    this.status = 'disconnected';
    this.registeredWorkspaceId = undefined;
    this.releaseWorkspaceWaiters();
  }

  private releaseWorkspaceWaiters(): void {
    for (const done of [...this.workspaceWaiters]) done();
  }

  private createWorkspaceMessage(): WorkspaceConnectedMessage {
    return this.describeWorkspace();
  }

  private handleMessage(data: RawData): void {
    if (this.disposed) return;
    let message: unknown;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.output.appendLine('[Gor] Ignored invalid server message');
      return;
    }

    if (!message || typeof message !== 'object') return;
    const payload = message as { type?: unknown };
    if (payload.type === 'workspace_request') {
      this.onWorkspaceRequest?.(
        message as WorkspaceRequestMessage,
        this.registeredWorkspaceId,
        (response) => this.send(response),
      );
      return;
    }

    const registered = message as Partial<WorkspaceRegisteredMessage>;
    if (registered.type !== 'workspace_registered' || typeof registered.workspaceId !== 'string') {
      this.onServerMessage?.(message as { type?: unknown } & Record<string, unknown>);
      return;
    }

    this.registeredWorkspaceId = registered.workspaceId;
    this.output.appendLine(`[Gor] Workspace registered: ${registered.workspaceId}`);
    this.onStatusChange(this.status, this.registeredWorkspaceId);
    this.releaseWorkspaceWaiters();
  }

  private setStatus(status: GorConnectionStatus): void {
    this.status = status;
    this.onStatusChange(status, this.registeredWorkspaceId);
  }

  private markDisconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.registeredWorkspaceId = undefined;
    this.output.appendLine('[Gor] Disconnected');
    this.setStatus('disconnected');
    socket.terminate();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.status === 'connected') return;
    const delayMs = Math.min(1000 * (2 ** this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.output.appendLine(`[Gor] Reconnecting in ${Math.ceil(delayMs / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => {
        // Failed attempts schedule the next retry from the socket error handler.
      });
    }, delayMs);
  }
}

import WebSocket, { RawData } from 'ws';
import * as vscode from 'vscode';

export type GorConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WorkspaceConnectedMessage = {
  type: 'workspace_connected';
  client: 'vscode';
  workspaceName: string;
  workspaceFolders: Array<{ id: string; name: string; uri: string }>;
};

type WorkspaceRegisteredMessage = {
  type: 'workspace_registered';
  workspaceId: string;
};

type WorkspaceRequestMessage = {
  type: 'workspace_request';
  requestId: string;
  workspaceId: string;
  method: string;
  params?: Record<string, unknown>;
};

type WorkspaceResponseMessage = {
  type: 'workspace_response';
  requestId: string;
  workspaceId: string;
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export class GorConnection implements vscode.Disposable {
  private socket: WebSocket | undefined;
  private disposed = false;
  private status: GorConnectionStatus = 'disconnected';
  private registeredWorkspaceId: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;

  constructor(
    private readonly serverUrl: string,
    private readonly output: vscode.OutputChannel,
    private readonly onStatusChange: (status: GorConnectionStatus, workspaceId?: string) => void,
    private readonly onWorkspaceRequest?: (
      request: WorkspaceRequestMessage,
      currentWorkspaceId: string | undefined,
      send: (response: WorkspaceResponseMessage) => boolean,
    ) => void,
  ) {}

  get currentStatus(): GorConnectionStatus {
    return this.status;
  }

  get workspaceId(): string | undefined {
    return this.registeredWorkspaceId;
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
  }

  private createWorkspaceMessage(): WorkspaceConnectedMessage {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return {
      type: 'workspace_connected',
      client: 'vscode',
      workspaceName: folders[0]?.name ?? '',
      workspaceFolders: folders.map((folder, index) => ({
        id: `root-${index + 1}`,
        name: folder.name,
        uri: folder.uri.toString(),
      })),
    };
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
    if (registered.type !== 'workspace_registered' || typeof registered.workspaceId !== 'string') return;

    this.registeredWorkspaceId = registered.workspaceId;
    this.output.appendLine(`[Gor] Workspace registered: ${registered.workspaceId}`);
    this.onStatusChange(this.status, this.registeredWorkspaceId);
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

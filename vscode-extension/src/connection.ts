import WebSocket, { RawData } from 'ws';
import * as vscode from 'vscode';

export type GorConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WorkspaceConnectedMessage = {
  type: 'workspace_connected';
  client: 'vscode';
  workspaceName: string;
  workspaceFolders: Array<{ name: string; uri: string }>;
};

type WorkspaceRegisteredMessage = {
  type: 'workspace_registered';
  workspaceId: string;
};

export class GorConnection implements vscode.Disposable {
  private socket: WebSocket | undefined;
  private disposed = false;
  private status: GorConnectionStatus = 'disconnected';
  private registeredWorkspaceId: string | undefined;

  constructor(
    private readonly serverUrl: string,
    private readonly output: vscode.OutputChannel,
    private readonly onStatusChange: (status: GorConnectionStatus, workspaceId?: string) => void,
  ) {}

  get currentStatus(): GorConnectionStatus {
    return this.status;
  }

  get workspaceId(): string | undefined {
    return this.registeredWorkspaceId;
  }

  connect(): Promise<void> {
    if (this.status === 'connected') return Promise.resolve();

    this.disposed = false;
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
        return;
      }

      this.socket = socket;
      socket.on('open', () => {
        if (this.disposed) return;
        this.output.appendLine('[Gor] Connected');
        this.setStatus('connected');
        this.send(this.createWorkspaceMessage());
        settle();
      });

      socket.on('message', (data: RawData) => this.handleMessage(data));

      socket.on('error', (error: Error) => {
        if (this.disposed) return;
        this.output.appendLine(`[Gor] Connection error: ${error.message}`);
        this.setStatus('disconnected');
        settle(error);
      });

      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
        if (this.disposed) return;
        this.output.appendLine('[Gor] Disconnected');
        this.setStatus('disconnected');
        settle(new Error('Gor Server closed the WebSocket connection'));
      });
    });
  }

  send(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message), (error) => {
      if (error && !this.disposed) {
        this.output.appendLine(`[Gor] Connection error: ${error.message}`);
        this.setStatus('disconnected');
      }
    });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.terminate();
    }
    this.status = 'disconnected';
  }

  private createWorkspaceMessage(): WorkspaceConnectedMessage {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return {
      type: 'workspace_connected',
      client: 'vscode',
      workspaceName: folders[0]?.name ?? '',
      workspaceFolders: folders.map((folder) => ({
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
}

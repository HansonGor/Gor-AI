import * as fs from 'node:fs/promises';
import { existsSync, watch as watchFileSystem } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { decodeSharePng } from './shareImageSave';
import { cancelToolchainRun, type ApprovalAnswer, type ApprovalRequest, type RunUpdate } from './workspace/toolchain/host';

type WebviewRequest = {
  type?: string;
  requestId?: string;
  sessionId?: string;
  message?: string;
  suggestedName?: string;
  base64?: string;
  approvalId?: string;
  answer?: string;
  runId?: string;
  url?: string;
};

export function isLocalDevUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// 卡片需在这段时间内被聊天页确认已展示，否则退回原生确认框（例如面板停在别的会话）。
const APPROVAL_SHOWN_TIMEOUT_MS = 1500;

type PendingApproval = {
  shown: boolean;
  onShown: () => void;
  onAnswer: (answer: ApprovalAnswer) => void;
};

type ActiveRequest = http.ClientRequest;

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'gor.chatView';
  private static current: ChatView | undefined;
  private view: vscode.WebviewView | undefined;
  private webview: vscode.Webview | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private registration: vscode.Disposable | undefined;
  private disposed = false;

  private constructor(
    extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    private readonly getWorkspaceId: () => string | undefined,
  ) {
    this.extensionUri = extensionUri;
    this.output = output;
  }

  private readonly output: vscode.OutputChannel;

  static register(
    extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    getWorkspaceId: () => string | undefined = () => undefined,
  ): ChatView {
    const provider = new ChatView(extensionUri, output, getWorkspaceId);
    provider.registration = vscode.window.registerWebviewViewProvider(
      ChatView.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    );
    ChatView.current = provider;
    return provider;
  }

  static async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.gor');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.view = view;
    this.webview = view.webview;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'chat')],
    };
    void this.getHtml(this.extensionUri, view.webview).then((html) => {
      if (!this.disposed && this.view === view) {
        view.webview.html = html;
        this.sendWorkspaceContext();
      }
    });
    view.webview.onDidReceiveMessage((message: WebviewRequest) => {
      void this.handleMessage(message);
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webview = undefined;
      }
    });
  }

  setWorkspaceContext(workspaceId?: string): void {
    this.post({
      type: 'gor.workspaceContext',
      workspaceId: workspaceId ?? null,
    });
  }

  private sendWorkspaceContext(): void {
    this.setWorkspaceContext(this.getWorkspaceId());
  }

  /**
   * 在聊天面板中展示施行审阅卡片并等待回答。
   * 面板不可见、或卡片未在限定时间内被展示时返回 undefined，由调用方退回原生确认框。
   */
  async requestToolchainApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer | undefined> {
    if (this.disposed || !this.webview || !this.view?.visible) return undefined;
    return new Promise<ApprovalAnswer | undefined>((resolve) => {
      let settled = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const settle = (answer: ApprovalAnswer | undefined) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        signal.removeEventListener('abort', onAbort);
        this.pendingApprovals.delete(request.approvalId);
        if (answer === undefined || answer === 'timeout' || answer === 'cancelled') {
          // 收回卡片：之后的状态由 update 消息给出。
          this.post({ type: 'gor.toolchain', kind: 'withdrawn', approvalId: request.approvalId, runId: request.runId });
        }
        resolve(answer);
      };
      const onAbort = () => settle('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingApprovals.set(request.approvalId, {
        shown: false,
        onShown: () => {
          const pending = this.pendingApprovals.get(request.approvalId);
          if (pending) pending.shown = true;
        },
        onAnswer: settle,
      });
      timers.push(setTimeout(() => {
        if (!this.pendingApprovals.get(request.approvalId)?.shown) settle(undefined);
      }, APPROVAL_SHOWN_TIMEOUT_MS));
      timers.push(setTimeout(() => settle('timeout'), Math.max(0, request.deadline - Date.now())));
      this.post({ type: 'gor.toolchain', kind: 'approval', request });
    });
  }

  postToolchainUpdate(update: RunUpdate): void {
    this.post({ type: 'gor.toolchain', kind: 'update', update });
  }

  static watchDevelopmentBuild(extensionUri: vscode.Uri, output: vscode.OutputChannel): vscode.Disposable {
    const buildDirectory = path.join(extensionUri.fsPath, 'media', 'chat');
    const buildSignalPath = path.join(buildDirectory, '.gor-build-complete');
    let reloadTimer: NodeJS.Timeout | undefined;

    try {
      const watcher = watchFileSystem(buildDirectory, (_eventType, filename) => {
        if (filename?.toString() !== '.gor-build-complete' || !existsSync(buildSignalPath)) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          const chatView = ChatView.current;
          if (chatView) void chatView.reloadWebview();
        }, 300);
      });

      return {
        dispose: () => {
          if (reloadTimer) clearTimeout(reloadTimer);
          watcher.close();
        },
      };
    } catch (error) {
      output.appendLine(`[Gor] Could not watch Webview build output: ${error instanceof Error ? error.message : String(error)}`);
      return { dispose: () => undefined };
    }
  }

  private async reloadWebview(): Promise<void> {
    if (this.disposed || !this.view) return;
    try {
      const view = this.view;
      const html = await this.getHtml(this.extensionUri, view.webview);
      if (this.disposed || this.view !== view) return;
      view.webview.html = html;
      this.sendWorkspaceContext();
      this.output.appendLine('[Gor] Refreshed Chat Webview after frontend rebuild');
    } catch (error) {
      this.output.appendLine(`[Gor] Could not refresh Chat Webview: ${this.errorText(error)}`);
    }
  }

  private async getHtml(extensionUri: vscode.Uri, webview: vscode.Webview): Promise<string> {
    const root = vscode.Uri.joinPath(extensionUri, 'media', 'chat');
    const htmlPath = path.join(root.fsPath, 'vscode.html');
    let html: string;
    try {
      html = await fs.readFile(htmlPath, 'utf8');
    } catch {
      return this.missingBuildHtml();
    }

    let apiOrigin: string;
    try {
      apiOrigin = this.getBaseUrl().origin;
    } catch (error) {
      return this.configurationErrorHtml(this.errorText(error));
    }
    const assetRoot = `${webview.asWebviewUri(root).toString().replace(/\/$/, '')}/`;
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} ${apiOrigin} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} ${apiOrigin} https: wss:`,
      `frame-src ${webview.cspSource} ${apiOrigin} https: data: blob:`,
      `worker-src ${webview.cspSource} blob:`,
      "object-src 'none'",
      `base-uri ${webview.cspSource}`,
    ].join('; ');
    html = html.replace(/(?:src|href)="\.\/assets\/([^"]+)"/g, (_match, asset: string) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', asset));
      return _match.startsWith('src=') ? `src="${uri}"` : `href="${uri}"`;
    });
    html = html
      .replace('__GOR_API_BASE__', apiOrigin)
      .replace('__GOR_ASSETS_BASE__', assetRoot);
    return html.replace(
      '<head>',
      `<head><base href="${assetRoot}"><meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
  }

  private configurationErrorHtml(error: string): string {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font:14px sans-serif;background:#1e1e1e;color:#ddd;padding:24px;line-height:1.7}code{color:#c4a7ff}</style></head><body><h2>Gor Chat API 地址无效</h2><p>${this.escapeHtml(error)}</p><p>请检查 VS Code 设置 <code>gor.httpBaseUrl</code>。</p></body></html>`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]!);
  }

  private missingBuildHtml(): string {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font:14px sans-serif;background:#1e1e1e;color:#ddd;padding:24px;line-height:1.7}code{color:#c4a7ff}</style></head><body><h2>Gor Chat 尚未构建</h2><p>请在 <code>vscode-extension</code> 目录先执行 <code>npm run build:webview</code>，然后重新运行扩展。</p></body></html>`;
  }

  private async handleMessage(message: WebviewRequest): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    switch (message.type) {
      case 'gor.saveShareImage': {
        const targetWebview = this.webview;
        try {
          const bytes = decodeSharePng(message.base64);
          const name = 'Gor-聊天.png';
          const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(homedir(), name)), filters: { 'PNG 图片': ['png'] } });
          if (uri) await vscode.workspace.fs.writeFile(uri, bytes);
          await targetWebview?.postMessage({ type: 'gor.shareImageSaved', requestId, saved: Boolean(uri) });
        } catch (error) { await targetWebview?.postMessage({ type: 'gor.shareImageSaved', requestId, saved: false, error: this.errorText(error) }); }
        break;
      }
      case 'gor.workspaceContextReady':
        this.sendWorkspaceContext();
        break;
      case 'gor.toolchainApprovalShown':
        if (typeof message.approvalId === 'string') this.pendingApprovals.get(message.approvalId)?.onShown();
        break;
      case 'gor.toolchainApprovalAnswer':
        if (typeof message.approvalId === 'string') {
          const answer = message.answer === 'approve' || message.answer === 'stop' ? message.answer : 'skip';
          this.pendingApprovals.get(message.approvalId)?.onAnswer(answer);
        }
        break;
      case 'gor.toolchainCancel':
        // 「止令」只终止这一条命令，本轮对话继续；模型会收到 cancelled 回执。
        if (typeof message.runId === 'string') cancelToolchainRun({ runId: message.runId });
        break;
      case 'gor.toolchainOpenUrl':
        // 只打开常驻进程打印的本机地址，其他地址一律忽略。
        if (typeof message.url === 'string' && isLocalDevUrl(message.url)) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case 'loadSessions':
        this.requestJson('loadSessions', requestId, 'GET', '/api/chat/sessions?userId=default%3Avscode', undefined);
        break;
      case 'createSession':
        this.requestJson('createSession', requestId, 'POST', '/api/chat/session/create', { userId: 'default:vscode' });
        break;
      case 'loadMessages':
        if (this.isSafeSessionId(message.sessionId)) {
          this.requestJson('loadMessages', requestId, 'GET', `/api/chat/session/${encodeURIComponent(message.sessionId!)}/messages`, undefined);
        }
        break;
      case 'sendMessage':
        if (this.isSafeSessionId(message.sessionId) && typeof message.message === 'string' && message.message.trim()) {
          this.streamChat(requestId, message.sessionId!, message.message.trim());
        }
        break;
      case 'cancelSend':
        if (requestId) {
          this.activeRequests.get(requestId)?.destroy(new Error('Cancelled by user'));
          this.activeRequests.delete(requestId);
        }
        break;
    }
  }

  private isSafeSessionId(value: unknown): value is string {
    return typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
  }

  private getBaseUrl(): URL {
    const configured = vscode.workspace.getConfiguration('gor').get<string>('httpBaseUrl', 'http://localhost:3001');
    const base = new URL(configured);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error('gor.httpBaseUrl 仅支持 http 或 https 地址。');
    }
    return base;
  }

  private requestJson(
    action: string,
    requestId: string,
    method: 'GET' | 'POST',
    route: string,
    body: Record<string, unknown> | undefined,
  ): void {
    let url: URL;
    try {
      url = new URL(route, this.getBaseUrl());
    } catch (error) {
      this.post({ type: 'apiResponse', action, requestId, success: false, error: this.errorText(error) });
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const request = transport.request(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: 30_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        this.activeRequests.delete(requestId);
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const data = text ? JSON.parse(text) : {};
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || data.success === false) {
            throw new Error(data.detail || data.error || `Gor API 请求失败 (${response.statusCode})`);
          }
          this.post({ type: 'apiResponse', action, requestId, success: true, data });
        } catch (error) {
          this.post({ type: 'apiResponse', action, requestId, success: false, error: this.errorText(error) });
        }
      });
    });
    this.activeRequests.set(requestId, request);
    request.on('timeout', () => request.destroy(new Error('连接 Gor Server 超时')));
    request.on('error', (error) => {
      this.activeRequests.delete(requestId);
      this.output.appendLine(`[Gor] Chat API error: ${error.message}`);
      this.post({ type: 'apiResponse', action, requestId, success: false, error: error.message });
    });
    if (payload) request.write(payload);
    request.end();
  }

  private streamChat(requestId: string, sessionId: string, message: string): void {
    let url: URL;
    try {
      url = new URL('/api/chat', this.getBaseUrl());
    } catch (error) {
      this.post({ type: 'chatError', requestId, error: this.errorText(error) });
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const workspaceId = this.getWorkspaceId();
    const payload = Buffer.from(JSON.stringify({
      sessionId,
      message,
      messages: [],
      clientMode: 'vscode',
      ...(workspaceId ? { workspaceId } : {}),
    }));
    let finalized = false;
    const finish = (error?: string) => {
      if (finalized) return;
      finalized = true;
      this.activeRequests.delete(requestId);
      this.post(error
        ? { type: 'chatError', requestId, error }
        : { type: 'chatDone', requestId });
    };
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: 0,
    }, (response) => {
      let buffer = '';
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => finish(Buffer.concat(chunks).toString('utf8') || `Gor API 请求失败 (${response.statusCode})`));
        return;
      }
      const dispatchFrame = (frame: string) => {
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'done') finish();
          else if (event.type === 'error') finish(event.message || 'Gor 回复失败');
          else this.post({ type: 'chatEvent', requestId, event });
        } catch {
          this.output.appendLine('[Gor] Ignored malformed chat SSE event');
        }
      };
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        frames.forEach(dispatchFrame);
      });
      response.on('end', () => {
        if (buffer.trim()) dispatchFrame(buffer);
        finish();
      });
      response.on('error', (error) => finish(error.message));
    });
    this.activeRequests.set(requestId, request);
    request.on('error', (error) => {
      if (error.message !== 'Cancelled by user') finish(error.message);
    });
    request.write(payload);
    request.end();
  }

  private post(message: Record<string, unknown>): void {
    if (!this.disposed && this.webview) void this.webview.postMessage(message);
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.registration?.dispose();
    this.registration = undefined;
    for (const request of this.activeRequests.values()) request.destroy();
    this.activeRequests.clear();
    for (const pending of [...this.pendingApprovals.values()]) pending.onAnswer('cancelled');
    this.pendingApprovals.clear();
    this.view = undefined;
    this.webview = undefined;
    if (ChatView.current === this) ChatView.current = undefined;
  }
}

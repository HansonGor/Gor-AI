import * as vscode from 'vscode';
import { GorConnection, GorConnectionStatus } from './connection';
import { ChatView } from './chatPanel';
import { WorkspaceRequestHandler } from './workspace/requestHandler';
import { rememberTextDocumentVersion } from './workspace/edits';
import { normalizeWorkspaceRelativePath, workspaceRelativePath } from './workspace/paths';
import { configureToolchainUi, disposeToolchainProcesses, nativeUi } from './workspace/toolchain/host';

let connection: GorConnection | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Gor');
  const expectedTreeEvents = new Map<string, ReturnType<typeof setTimeout>>();
  const workspaceRequestHandler = new WorkspaceRequestHandler(output, (method, params) => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const requestedRoot = params.root;
    const folderIndex = folders.findIndex((folder, index) =>
      requestedRoot === `root-${index + 1}` || requestedRoot === folder.name,
    );
    const folder = folderIndex >= 0 ? folders[folderIndex] : folders.length === 1 ? folders[0] : undefined;
    if (!folder || typeof params.path !== 'string') return undefined;
    let path: string;
    try { path = normalizeWorkspaceRelativePath(params.path, method === 'project.deleteDirectory'); } catch { return undefined; }
    if (!path) return undefined;
    const rootId = folders.length > 1 ? `root-${folderIndex + 1}` : '';
    const paths = [path];
    if (method === 'project.createDirectory') {
      const parts = path.slice(1).split('/');
      for (let index = 1; index < parts.length; index += 1) {
        paths.push(`/${parts.slice(0, index).join('/')}`);
      }
    }
    const keys = paths.map((item) => `${rootId}:${item}`);
    for (const key of keys) {
      const previous = expectedTreeEvents.get(key);
      if (previous) clearTimeout(previous);
      expectedTreeEvents.set(key, setTimeout(() => expectedTreeEvents.delete(key), 3000));
    }
    return () => {
      for (const key of keys) {
        const timeout = expectedTreeEvents.get(key);
        if (timeout) clearTimeout(timeout);
        expectedTreeEvents.delete(key);
      }
    };
  });
  for (const document of vscode.workspace.textDocuments) rememberTextDocumentVersion(document);
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(({ document }) => {
    // VS Code versions stay local; each Gor request reads the current document on demand.
    rememberTextDocumentVersion(document);
  }));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let chatView: ChatView | undefined;

  const treeWatchers: vscode.Disposable[] = [];
  const excludedTreeSegments = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage', 'out', 'vendor',
    '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
  ]);
  const refreshTreeWatchers = () => {
    while (treeWatchers.length) treeWatchers.pop()?.dispose();
    const folders = vscode.workspace.workspaceFolders ?? [];
    folders.forEach((folder, index) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      const rootId = folders.length > 1 ? `root-${index + 1}` : undefined;
      const reportChange = (uri: vscode.Uri) => {
        let path: string;
        try { path = workspaceRelativePath(uri, folder); } catch { return; }
        if (path.slice(1).split('/').some((segment) => excludedTreeSegments.has(segment.toLowerCase()))) return;
        const eventKey = `${rootId ?? ''}:${path}`;
        const expected = expectedTreeEvents.get(eventKey);
        if (expected) {
          clearTimeout(expected);
          expectedTreeEvents.delete(eventKey);
          return;
        }
        connection?.notifyWorkspaceTreeChanged(rootId);
      };
      treeWatchers.push(
        watcher,
        watcher.onDidCreate(reportChange),
        watcher.onDidDelete(reportChange),
      );
    });
  };
  refreshTreeWatchers();
  context.subscriptions.push(
    { dispose: () => { while (treeWatchers.length) treeWatchers.pop()?.dispose(); } },
    vscode.workspace.onDidChangeWorkspaceFolders(refreshTreeWatchers),
  );
  output.appendLine('[Gor] Extension activated');

  const updateStatus = (status: GorConnectionStatus, workspaceId?: string) => {
    chatView?.setWorkspaceContext(workspaceId);
    switch (status) {
      case 'connecting':
        statusBar.text = '$(sync~spin) Gor: Connecting...';
        statusBar.tooltip = 'Connecting to Gor Server';
        break;
      case 'connected':
        statusBar.text = workspaceId ? '$(check) Gor: Workspace Connected' : '$(sync~spin) Gor: Registering Workspace...';
        statusBar.tooltip = workspaceId
          ? `Workspace bridge ready: ${workspaceId}`
          : 'Gor Server 已连接，正在注册当前 VS Code 工作区';
        break;
      default:
        statusBar.text = '$(circle-slash) Gor: Disconnected';
        statusBar.tooltip = 'Gor Server is disconnected';
        break;
    }
    statusBar.show();
  };

  const connect = () => {
    connection?.dispose();
    const serverUrl = vscode.workspace.getConfiguration('gor').get<string>(
      'serverUrl',
      'ws://localhost:3001/ws/vscode',
    );
    connection = new GorConnection(serverUrl, output, updateStatus, (message, workspaceId, send) => {
      void workspaceRequestHandler.handle(message, workspaceId, send);
    });
    updateStatus('connecting');
    void connection.connect().catch(() => {
      // Connection errors are reported in the Gor OutputChannel and status bar.
    });
  };

  const reconnectCommand = vscode.commands.registerCommand('gor.reconnect', connect);
  chatView = ChatView.register(context.extensionUri, output, () => connection?.workspaceId);
  const toolchainOutput = vscode.window.createOutputChannel('Gor 工具链');
  configureToolchainUi({
    // 审阅卡片优先展示在聊天面板；面板不可见或未能展示时退回原生确认框。
    requestApproval: async (request, signal) =>
      (await chatView?.requestToolchainApproval(request, signal)) ?? nativeUi.requestApproval(request, signal),
    update: (update) => chatView?.postToolchainUpdate(update),
    output: (text) => toolchainOutput.append(text),
  });
  context.subscriptions.push(toolchainOutput, { dispose: disposeToolchainProcesses });
  const openChatCommand = vscode.commands.registerCommand('gor.openChat', () => {
    void ChatView.reveal();
  });
  context.subscriptions.push(output, statusBar, reconnectCommand, openChatCommand, chatView, { dispose: () => connection?.dispose() });
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    context.subscriptions.push(ChatView.watchDevelopmentBuild(context.extensionUri, output));
  }

  updateStatus('connecting');
  connect();
}

export function deactivate(): void {
  disposeToolchainProcesses();
  connection?.dispose();
  connection = undefined;
}

import * as vscode from 'vscode';
import { GorConnection, GorConnectionStatus } from './connection';
import { ChatView } from './chatPanel';

let connection: GorConnection | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Gor');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  output.appendLine('[Gor] Extension activated');

  const updateStatus = (status: GorConnectionStatus, workspaceId?: string) => {
    switch (status) {
      case 'connecting':
        statusBar.text = '$(sync~spin) Gor: Connecting...';
        statusBar.tooltip = 'Connecting to Gor Server';
        break;
      case 'connected':
        statusBar.text = '$(check) Gor: Connected';
        statusBar.tooltip = workspaceId ? `Workspace: ${workspaceId}` : 'Connected to Gor Server';
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
    connection = new GorConnection(serverUrl, output, updateStatus);
    updateStatus('connecting');
    void connection.connect().catch(() => {
      // Connection errors are reported in the Gor OutputChannel and status bar.
    });
  };

  const reconnectCommand = vscode.commands.registerCommand('gor.reconnect', connect);
  const chatView = ChatView.register(context.extensionUri, output);
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
  connection?.dispose();
  connection = undefined;
}

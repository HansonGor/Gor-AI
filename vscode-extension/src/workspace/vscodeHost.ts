import * as vscode from 'vscode';
import {
  setWorkspaceHost,
  type HostFolder,
  type HostPosition,
  type HostUri,
  type HostWorkspaceEdit,
  type WorkspaceHost,
} from '@gor/workspace-core';

/**
 * VS Code 适配器：公共工作区核心经此访问当前连接的 VS Code 工作区。
 * 返回的都是 VS Code 原生对象，未保存编辑、撤销栈、保存参与者等行为保持不变；
 * 每次调用都现取 vscode.workspace 的状态，不缓存工作区文件夹或文档列表。
 */
export const vscodeWorkspaceHost: WorkspaceHost = {
  workspaceFolders: () => vscode.workspace.workspaceFolders,
  joinPath: (base, ...segments) => vscode.Uri.joinPath(base as vscode.Uri, ...segments),
  fs: {
    stat: (uri) => vscode.workspace.fs.stat(uri as vscode.Uri),
    readFile: (uri) => vscode.workspace.fs.readFile(uri as vscode.Uri),
    readDirectory: (uri) => vscode.workspace.fs.readDirectory(uri as vscode.Uri),
    createDirectory: (uri) => vscode.workspace.fs.createDirectory(uri as vscode.Uri),
    delete: (uri, options) => vscode.workspace.fs.delete(uri as vscode.Uri, options),
  },
  textDocuments: () => vscode.workspace.textDocuments,
  activeDocument: () => vscode.window.activeTextEditor?.document,
  openTextDocument: (uri) => vscode.workspace.openTextDocument(uri as vscode.Uri),
  createEdit: () => new vscode.WorkspaceEdit() as unknown as HostWorkspaceEdit,
  applyEdit: (edit) => vscode.workspace.applyEdit(edit as unknown as vscode.WorkspaceEdit),
  position: (line, character) => new vscode.Position(line, character),
  range: (start: HostPosition, end: HostPosition) => new vscode.Range(start as vscode.Position, end as vscode.Position),
  findFiles: (root: HostFolder, include, exclude, maxResults) => vscode.workspace.findFiles(
    new vscode.RelativePattern(root as vscode.WorkspaceFolder, include),
    exclude,
    maxResults,
  ) as PromiseLike<HostUri[]>,
  isTrusted: () => vscode.workspace.isTrusted !== false,
  configuration: (section, key) => vscode.workspace.getConfiguration?.(section)?.get<unknown>(key),
  showWarningModal: (message, detail, actions) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions),
  showInputBox: (options) => vscode.window.showInputBox(options),
  getExtension: <T>(id: string) => vscode.extensions?.getExtension?.<T>(id),
};

export function installVsCodeWorkspaceHost(): void {
  setWorkspaceHost(vscodeWorkspaceHost);
}

import * as vscode from 'vscode';
import {
  GorConnection as WorkspaceConnection,
  type GorConnectionStatus,
  type WorkspaceRequestMessage,
  type WorkspaceResponseMessage,
} from '@gor/workspace-core';

export type { GorConnectionStatus };

/** 插件的工作区连接：登记当前打开的 VS Code 工作区文件夹，连接与重连逻辑在公共核心。 */
export class GorConnection extends WorkspaceConnection implements vscode.Disposable {
  constructor(
    serverUrl: string,
    output: vscode.OutputChannel,
    onStatusChange: (status: GorConnectionStatus, workspaceId?: string) => void,
    onWorkspaceRequest?: (
      request: WorkspaceRequestMessage,
      currentWorkspaceId: string | undefined,
      send: (response: WorkspaceResponseMessage) => boolean,
    ) => void,
  ) {
    super(serverUrl, output, onStatusChange, onWorkspaceRequest, () => {
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
    });
  }
}

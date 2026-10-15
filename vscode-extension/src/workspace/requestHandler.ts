import * as vscode from 'vscode';
import {
  createProjectDirectory,
  createProjectFile,
  deleteProjectDirectory,
  deleteProjectFile,
  listProjectFiles,
  readProjectFile,
  searchProjectCode,
} from './files';
import { applyProjectPatches, patchProjectFile, writeProjectFile } from './edits';
import { normalizeWorkspaceRelativePath, WorkspaceRequestError } from './paths';
import { inspectFiles, restoreFiles, validateExpected } from './changes';
import { gitCommit, gitPush, gitStatus } from './git';
import { cancelToolchainRun, listToolchains, runToolchainAction } from './toolchain/host';

export type WorkspaceRequestPacket = {
  type: 'workspace_request';
  requestId: string;
  workspaceId: string;
  method: string;
  params?: Record<string, unknown>;
};

export type WorkspaceResponsePacket = {
  type: 'workspace_response';
  requestId: string;
  workspaceId: string;
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

// Serialize Agent RPC operations across handler instances; manual edits remain native.
let workspaceRequests: Promise<void> = Promise.resolve();

export class WorkspaceRequestHandler {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly expectTreeMutation?: (method: string, params: Record<string, unknown>) => (() => void) | undefined,
  ) {}

  async handle(
    request: WorkspaceRequestPacket,
    currentWorkspaceId: string | undefined,
    send: (response: WorkspaceResponsePacket) => boolean,
  ): Promise<void> {
    // 工具链任务可能等待用户允准或运行数分钟，使用自己的队列，不阻塞文件读写；取消必须立即送达。
    if (typeof request.method === 'string' && request.method.startsWith('toolchain.')) {
      return this.execute(request, currentWorkspaceId, send);
    }
    const task = workspaceRequests.then(() => this.execute(request, currentWorkspaceId, send));
    workspaceRequests = task.catch(() => undefined);
    return task;
  }

  private async execute(
    request: WorkspaceRequestPacket,
    currentWorkspaceId: string | undefined,
    send: (response: WorkspaceResponsePacket) => boolean,
  ): Promise<void> {
    const requestId = typeof request.requestId === 'string' ? request.requestId : '';
    const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId : '';
    const method = typeof request.method === 'string' ? request.method : '';
    const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params
      : {};
    if (!requestId || requestId.length > 128 || !workspaceId) return;

    if (workspaceId !== currentWorkspaceId) {
      send({
        type: 'workspace_response', requestId, workspaceId, success: false,
        error: { code: 'WORKSPACE_NOT_FOUND', message: '请求不属于当前已注册的 VS Code 工作区。' },
      });
      return;
    }

    let response: WorkspaceResponsePacket;
    let safePath = '';
    if (typeof params.path === 'string') {
      try { safePath = ` ${normalizeWorkspaceRelativePath(params.path).slice(0, 180)}`; } catch { /* never log unsafe host paths */ }
    }
    if (method === 'project.patchFile') {
      this.output.appendLine(`[Gor Workspace] patchFile${safePath}`);
    } else if (method === 'project.applyPatches') {
      const patches = Array.isArray(params.patches) ? params.patches : [];
      const paths = new Set(patches.flatMap((patch) => {
        if (!patch || typeof patch !== 'object' || typeof (patch as Record<string, unknown>).path !== 'string') return [];
        try { return [normalizeWorkspaceRelativePath((patch as Record<string, unknown>).path)]; } catch { return []; }
      }));
      this.output.appendLine(`[Gor Workspace] applyPatches files=${paths.size}`);
    } else if (method === 'project.writeFile') {
      this.output.appendLine(`[Gor Workspace] writeFile${safePath}`);
    } else if (method === 'project.createFile') {
      this.output.appendLine(`[Gor Workspace] createFile${safePath}`);
    } else if (method === 'project.createDirectory') {
      this.output.appendLine(`[Gor Workspace] createDirectory${safePath}`);
    } else if (method === 'project.deleteFile') {
      this.output.appendLine(`[Gor Workspace] deleteFile${safePath}`);
    } else if (method === 'project.deleteDirectory') {
      this.output.appendLine(`[Gor Workspace] deleteDirectory${safePath}`);
    } else {
      this.output.appendLine(`[Gor Workspace] request ${method}${safePath}`);
    }
    let releaseExpectedTreeMutation: (() => void) | undefined;
    try {
      const maxRequestChars = method === 'project.patchFile' || method === 'project.applyPatches'
        || method === 'project.writeFile' || method === 'project.createFile' || method === 'project.restoreFiles'
        ? 24_000_000
        : 16_000;
      if (JSON.stringify(params).length > maxRequestChars) {
        throw new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', '工作区请求参数过大。');
      }
      if ([
        'project.createFile', 'project.createDirectory', 'project.deleteFile', 'project.deleteDirectory',
      ].includes(method)) {
        releaseExpectedTreeMutation = this.expectTreeMutation?.(method, params);
      }
      let result: Record<string, unknown>;
      const groups = Array.isArray(params.changeExpectedGroups)
        ? params.changeExpectedGroups as Array<{ root: unknown; files: Record<string, { version: number | null }> }> : [];
      for (const group of groups) await validateExpected({ root: group.root }, group.files as never);
      if (groups.length && Array.isArray(params.patches)) {
        params.patches = params.patches.map((value) => {
          const patch = value as Record<string, unknown>;
          const group = groups.find(g => g.root === (patch.root ?? params.root));
          return { ...patch, expectedFileVersion: patch.expectedFileVersion ??
            group?.files[normalizeWorkspaceRelativePath(patch.path)]?.version };
        });
      }
      if (params.changeExpected) {
        await validateExpected(params, params.changeExpected as never);
        const expected = params.changeExpected as Record<string, { version: number | null }>;
        if (method === 'project.applyPatches' && Array.isArray(params.patches)) {
          params.patches = params.patches.map((value) => {
            const patch = value as Record<string, unknown>;
            const state = expected[normalizeWorkspaceRelativePath(patch.path)];
            return { ...patch, expectedFileVersion: patch.expectedFileVersion ?? state?.version };
          });
        } else if (typeof params.path === 'string') {
          params.expectedFileVersion ??= expected[normalizeWorkspaceRelativePath(params.path)]?.version;
        }
      }
      switch (method) {
        case 'project.inspectFiles':
          result = await inspectFiles(params);
          break;
        case 'project.restoreFiles':
          result = await restoreFiles(params);
          break;
        case 'project.listFiles':
          result = await listProjectFiles(params);
          break;
        case 'project.searchCode':
          result = await searchProjectCode(params);
          break;
        case 'project.readFile':
          result = await readProjectFile(params);
          break;
        case 'project.patchFile':
          result = await patchProjectFile(params);
          break;
        case 'project.applyPatches':
          result = await applyProjectPatches(params);
          break;
        case 'project.writeFile':
          result = await writeProjectFile(params);
          break;
        case 'project.createFile':
          result = await createProjectFile(params);
          break;
        case 'project.createDirectory':
          result = await createProjectDirectory(params);
          break;
        case 'project.deleteFile':
          result = await deleteProjectFile(params);
          break;
        case 'project.deleteDirectory':
          result = await deleteProjectDirectory(params);
          break;
        case 'git.status':
          result = await gitStatus(params);
          break;
        case 'git.commit':
          result = await gitCommit(params);
          break;
        case 'git.push':
          result = await gitPush(params);
          break;
        case 'toolchain.list':
          result = await listToolchains(params);
          break;
        case 'toolchain.run':
          result = await runToolchainAction(params);
          break;
        case 'toolchain.cancel':
          result = cancelToolchainRun(params);
          break;
        default:
          throw new WorkspaceRequestError('UNSUPPORTED_OPERATION', '该 VS Code Workspace 操作尚未开放。');
      }
      if (params.changeExpected) {
        result.changeSnapshots = (await inspectFiles({ root: params.root,
          paths: Object.keys(params.changeExpected as object) })).files;
      }
      if (groups.length) {
        result.changeSnapshotGroups = [];
        for (const group of groups) (result.changeSnapshotGroups as unknown[]).push({ root: group.root,
          files: (await inspectFiles({ root: group.root, paths: Object.keys(group.files) })).files });
      }
      response = { type: 'workspace_response', requestId, workspaceId, success: true, result };
      const changed = result.changed === true;
      this.output.appendLine((changed && (method === 'project.patchFile' || method === 'project.applyPatches' || method === 'project.writeFile'))
        || result.created === true || result.deleted === true
        ? '[Gor Workspace] applyEdit success'
        : '[Gor Workspace] response success');
    } catch (error) {
      releaseExpectedTreeMutation?.();
      const known = error instanceof WorkspaceRequestError
        ? error
        : new WorkspaceRequestError('WORKSPACE_REQUEST_FAILED', 'VS Code Workspace 请求失败。');
      if (params.changeExpected && known.details) {
        try {
          known.details.changeSnapshots = (await inspectFiles({ root: params.root,
            paths: Object.keys(params.changeExpected as object) })).files;
        } catch { /* The original error remains authoritative. */ }
      }
      if (Array.isArray(params.changeExpectedGroups) && known.details) {
        try {
          const snapshots = [];
          for (const value of params.changeExpectedGroups) {
            const group = value as { root: unknown; files: object };
            snapshots.push({ root: group.root,
              files: (await inspectFiles({ root: group.root, paths: Object.keys(group.files) })).files });
          }
          known.details.changeSnapshotGroups = snapshots;
        } catch { /* Preserve the original failure and Diff. */ }
      }
      response = {
        type: 'workspace_response', requestId, workspaceId, success: false,
        error: { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) },
      };
      if (known.code === 'VERSION_CONFLICT') {
        let conflictPath = safePath;
        if (!conflictPath) {
          const embeddedPath = known.message.match(/(?:：|:)\s*(\/[^\s]+)/)?.[1];
          if (embeddedPath) {
            try { conflictPath = ` ${normalizeWorkspaceRelativePath(embeddedPath)}`; } catch { /* don't log unsafe paths */ }
          }
        }
        this.output.appendLine(`[Gor Workspace] version conflict${conflictPath}`);
      }
      this.output.appendLine(`[Gor Workspace] response success=false code=${known.code}`);
    }
    send(response);
  }
}

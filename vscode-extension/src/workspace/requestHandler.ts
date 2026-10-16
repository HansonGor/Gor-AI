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
import { gitStatus } from './git';
import { cancelToolchainRun, confirmOperation, listToolchains, runToolchainAction } from './toolchain/host';
import { prepareProjectDelete } from './projectDelete';
import { describeExternalTarget, listExternalDirectory, readExternalFile, resolveExternalPath } from './external';

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
    // 项目外只读请求同样可能等待确认，且不触碰工作区文件，也不进入文件队列。
    if (typeof request.method === 'string' && (request.method.startsWith('toolchain.') || request.method.startsWith('external.'))) {
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
          result = await confirmedDelete(params, 'file', (confirm) => deleteProjectFile(params, confirm));
          break;
        case 'project.deleteDirectory':
          result = params.recursive === true
            ? await confirmedProjectDelete(params)
            : await confirmedDelete(params, 'directory', (confirm) => deleteProjectDirectory(params, confirm));
          break;
        case 'git.status':
          result = await gitStatus(params);
          break;
        case 'git.commit':
          result = await legacyGit('commit', params);
          break;
        case 'git.push':
          result = await legacyGit('push', params);
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
        case 'external.readFile':
          result = await confirmedExternal(params, 'file');
          break;
        case 'external.listDirectory':
          result = await confirmedExternal(params, 'directory');
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

const MODE_KEYS = ['approvalMode', 'sessionId', 'roundId', 'runId'] as const;

function modeParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(MODE_KEYS.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
}

/**
 * git.commit / git.push 旧接口：改走工具链框架（按模式决定是否确认），回执保持原来的形状，
 * 未执行时仍以错误码返回，兼容 git_commit / git_push 工具与思考摘要。
 */
async function legacyGit(action: 'commit' | 'push', params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  for (const key of ['message', 'paths', 'remote', 'force']) if (params[key] !== undefined) args[key] = params[key];
  const result = await runToolchainAction({ toolchain: 'git', action, args, root: params.root, ...modeParams(params) });
  const status = result.status;
  if (status === 'completed') return { ...((result.data as Record<string, unknown>) ?? {}), runId: result.runId };
  const summary = typeof result.summary === 'string' ? result.summary : '未执行。';
  if (status === 'user_cancelled' || status === 'approval_timeout' || status === 'cancelled') {
    throw new WorkspaceRequestError('USER_CANCELLED', action === 'commit'
      ? `用户取消了提交，未做任何改动。（${summary}）` : `用户取消了推送，未做任何改动。（${summary}）`);
  }
  if (status === 'plan_changed') throw new WorkspaceRequestError('GIT_STATE_CHANGED', '确认期间仓库状态发生变化，未执行。请重新查看改动后再试。');
  if (status === 'workspace_untrusted') throw new WorkspaceRequestError('WORKSPACE_UNTRUSTED', summary);
  throw new WorkspaceRequestError(typeof result.code === 'string' ? result.code : status === 'rejected' ? 'GIT_REJECTED' : 'GIT_OPERATION_FAILED', summary);
}

function cancelledError(result: Record<string, unknown>, verb: string): WorkspaceRequestError {
  const summary = typeof result.summary === 'string' && result.summary ? result.summary : '用户取消了操作';
  return new WorkspaceRequestError(result.status === 'workspace_untrusted' ? 'WORKSPACE_UNTRUSTED' : 'USER_CANCELLED', `${summary}，未${verb}。`);
}

/**
 * 删除文件或空目录：R2，两种模式都要确认。原有检查（未保存编辑、版本、受保护路径、非空目录）先执行，
 * 通过后才弹卡片，避免确认一个注定失败的删除。审阅模式的删除先成为候选，落笔走恢复接口，不经过这里。
 */
async function confirmedDelete(params: Record<string, unknown>, target: 'file' | 'directory',
  run: (confirm: () => Promise<void>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  let shownPath = '';
  let report: ((ok: boolean, summary: string) => void) | undefined;
  const confirm = async () => {
    // 走到这里说明原有路径检查已通过，展示路径可以安全规范化。
    shownPath = normalizeWorkspaceRelativePath(params.path, target === 'directory') || '/';
    const gate = await confirmOperation({
      ...modeParams(params), kind: 'file', toolchain: 'file', action: target === 'file' ? 'delete_file' : 'delete_directory',
      level: 2, allowKey: `file:delete_${target}`, command: `删除${target === 'file' ? '文件' : '空目录'} ${shownPath}`, cwd: '/',
      details: [`路径：${shownPath}`], effects: ['移到系统回收站'],
    });
    if ('result' in gate) throw cancelledError(gate.result, '删除');
    report = gate.report;
  };
  try {
    const result = await run(confirm);
    report?.(true, `已删除 ${shownPath}（在系统回收站中）`);
    return result;
  } catch (error) {
    report?.(false, error instanceof Error ? error.message : '删除失败');
    throw error;
  }
}

/** 删除整个项目目录（递归）：只限含 package.json 或 .git 的目录，两种模式都要确认。 */
async function confirmedProjectDelete(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prepared = await prepareProjectDelete(params);
  const gate = await confirmOperation({
    ...modeParams(params), kind: 'file', toolchain: 'file', action: 'delete_project', level: 2, allowKey: 'file:delete_project',
    command: `删除项目 ${prepared.path}`, cwd: '/',
    details: [
      `路径：${prepared.path}`,
      `包含 ${prepared.countTruncated ? '超过 ' : ''}${prepared.fileCount} 个文件（含 ${prepared.markers.join('、')}）`,
    ],
    effects: ['整个目录移到系统回收站', 'Gor 的「复原」不覆盖整目录删除，需要时请从回收站还原'],
  });
  if ('result' in gate) throw cancelledError(gate.result, '删除');
  try {
    const result = await prepared.execute();
    gate.report(true, `已删除项目 ${prepared.path}（${prepared.fileCount} 个文件，在系统回收站中）`);
    return result;
  } catch (error) {
    gate.report(false, error instanceof Error ? error.message : '删除失败');
    throw error;
  }
}

/** 项目外只读：R3，两种模式每次都要确认；新建、修改、删除项目外文件的能力不提供。 */
async function confirmedExternal(params: Record<string, unknown>, expected: 'file' | 'directory'): Promise<Record<string, unknown>> {
  const absolute = await resolveExternalPath(params.path);
  const target = await describeExternalTarget(absolute);
  if (target.type !== expected) {
    throw new WorkspaceRequestError('INVALID_PATH', expected === 'file' ? '目标是目录，请用列出目录。' : '目标是文件，请用读取文件。');
  }
  const gate = await confirmOperation({
    ...modeParams(params), kind: 'external', toolchain: 'file', action: expected === 'file' ? 'read_external_file' : 'list_external_directory',
    level: 3, allowKey: `external:read_${expected}`, command: `${expected === 'file' ? '读取' : '查看目录'} ${absolute}`, cwd: '项目外',
    details: [`完整路径：${absolute}`, ...(expected === 'file' ? [`大小：${Math.ceil(target.size / 1024)} KB`] : [])],
    effects: ['只读，不会修改、新建或删除项目外的文件'],
  });
  if ('result' in gate) throw cancelledError(gate.result, '读取');
  try {
    const result = expected === 'file'
      ? await readExternalFile(absolute, params.startLine, params.endLine)
      : await listExternalDirectory(absolute);
    gate.report(true, expected === 'file' ? `已读取 ${absolute}` : `已列出 ${absolute}`);
    return result;
  } catch (error) {
    gate.report(false, error instanceof Error ? error.message : '读取失败');
    throw error;
  }
}

import { gitLog, gitStatus, prepareBranchOperation, prepareCommit, preparePush, type PreparedGitOperation } from '../../git';
import { WorkspaceRequestError } from '../../paths';
import { mergeWarnings, scanFiles, type RiskLevel } from '../risk';
import type { ActionContext, ActionSpec, ExecPlan, Params, ToolchainProfile } from '../types';

/**
 * Git 工具链：经 VS Code 内置 Git 扩展 API 操作当前工作区的真实仓库，不启动 git 子进程。
 * 等级：status / diff / log 为 R0；commit、push、pull、fetch、新建/切换分支为 R1；
 * 删除分支、放弃未提交改动为 R2；强制推送为 R4（直接拒绝）。
 */

const GIT_TIMEOUT_MS = 10 * 60 * 1000;

function isPrepared(value: PreparedGitOperation | Record<string, unknown>): value is PreparedGitOperation {
  return typeof (value as PreparedGitOperation).execute === 'function';
}

function withRoot(params: Params, context: ActionContext): Params {
  return { ...params, root: context.root.name };
}

function readPlan(action: string, run: (params: Params) => Promise<Record<string, unknown>>, command: string): ActionSpec {
  return {
    id: action,
    level: 0,
    description: command,
    async plan(params, context) {
      return {
        kind: 'git', cwd: context.cwd, cwdUri: context.cwdUri, timeoutMs: GIT_TIMEOUT_MS,
        level: 0, allowKey: `git:${action}`, display: { command, effects: [] },
        fingerprint: async () => 'static',
        execute: async () => ({ ok: true, summary: '', data: await run(withRoot(params, context)) }),
      };
    },
  };
}

function preparedPlan(action: string, level: RiskLevel, prepared: PreparedGitOperation, context: ActionContext, effects: string[], warnings: ExecPlan['warnings']): ExecPlan {
  return {
    kind: 'git', cwd: context.cwd, cwdUri: context.cwdUri, timeoutMs: GIT_TIMEOUT_MS,
    level, allowKey: `git:${action}`, warnings,
    display: { command: prepared.command, details: prepared.details, effects: prepared.effects ?? effects, ...(prepared.editable ? { editable: prepared.editable } : {}) },
    fingerprint: prepared.fingerprint,
    execute: async (_signal, input) => ({ ok: true, summary: '', data: await prepared.execute(input) }),
  };
}

function writeAction(action: string, level: RiskLevel, description: string, effects: string[],
  prepare: (params: Params) => Promise<PreparedGitOperation | Record<string, unknown>>): ActionSpec {
  return {
    id: action,
    level,
    description,
    async plan(params, context) {
      const prepared = await prepare(withRoot(params, context));
      if (!isPrepared(prepared)) {
        // 无需执行（例如没有需要推送的提交）：直接带回结果，不打扰用户。
        return {
          kind: 'git', cwd: context.cwd, cwdUri: context.cwdUri, timeoutMs: GIT_TIMEOUT_MS,
          level: 0, allowKey: `git:${action}`, display: { command: `git ${action}`, effects: [] },
          fingerprint: async () => 'static', execute: async () => ({ ok: true, summary: '', data: prepared }),
        };
      }
      // 提交、推送、切换分支会自动执行仓库里的 Git 钩子，执行前一并研判。
      const hookWarnings = mergeWarnings(await scanFiles(prepared.hookFiles, context.root.uri.fsPath));
      return preparedPlan(action, level, prepared, context, effects, hookWarnings);
    },
  };
}

export const gitProfile: ToolchainProfile = {
  id: 'git',
  async detect() {
    return { available: true };
  },
  async describe(root) {
    try {
      const status = await gitStatus({ root: root.name });
      return { available: true, branch: status.branch, upstream: status.upstream, ahead: status.ahead, behind: status.behind };
    } catch (error) {
      // Git 扩展被禁用、不在仓库中等情况：只报告不可用，不影响其他工具链。
      return { available: false, reason: error instanceof WorkspaceRequestError ? error.message : 'VS Code Git 功能不可用。' };
    }
  },
  actions: [
    readPlan('status', (params) => gitStatus(params), 'git status'),
    readPlan('diff', (params) => gitStatus({ ...params, includeDiff: true }), 'git diff'),
    readPlan('log', gitLog, 'git log'),
    writeAction('commit', 1, '提交改动并默认推送到远端（params.message，可选 params.paths；params.push=false 只提交本地）', ['会在本地仓库新建一个提交'], prepareCommit),
    writeAction('push', 1, '推送当前分支（可选 params.remote；永不强制推送）', ['推送后其他人可见'], preparePush),
    writeAction('pull', 1, '拉取并合并上游', ['会修改工作区文件'], (params) => prepareBranchOperation('pull', params)),
    writeAction('fetch', 1, '获取远端更新（不修改工作区）', [], (params) => prepareBranchOperation('fetch', params)),
    writeAction('create_branch', 1, '新建分支（params.name，默认切换过去）', [], (params) => prepareBranchOperation('create_branch', params)),
    writeAction('switch_branch', 1, '切换分支（params.name）', ['会修改工作区文件'], (params) => prepareBranchOperation('switch_branch', params)),
    writeAction('delete_branch', 2, '删除本地分支（params.name；params.force 强制删除未合并分支）', ['删除分支'], (params) => prepareBranchOperation('delete_branch', params)),
    writeAction('discard', 2, '放弃指定文件的未提交改动（params.paths）', ['未提交的改动会丢失'], (params) => prepareBranchOperation('discard', params)),
  ],
};

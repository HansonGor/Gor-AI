import type * as vscode from 'vscode';

/**
 * 工具链框架的公共类型。git / node / python / java 都以 Profile 接入，
 * 模型只选择「工具链 + 动作 + 参数」，实际命令由 Profile 生成，扩展决定是否放行。
 */

export type Risk = 'read' | 'verify' | 'write' | 'network' | 'publish';
export type ApprovalMode = 'auto' | 'review';
export type Params = Record<string, unknown>;

export type ToolchainEnv = {
  available: boolean;
  version?: string;
  reason?: string;
  [key: string]: unknown;
};

export type ActionContext = {
  root: vscode.WorkspaceFolder;
  /** 工作区相对目录（以 / 开头），已经过路径校验。 */
  cwd: string;
  cwdUri: vscode.Uri;
  env: ToolchainEnv;
};

/** 一条将要执行的命令；审阅卡片展示的正是这里的内容。 */
export type ExecPlan = {
  argv: string[];
  cwd: string;
  cwdUri: vscode.Uri;
  timeoutMs: number;
  risk: Risk;
  /** 内置白名单动作：即刻落笔模式下可不经确认直接执行。 */
  allowlisted: boolean;
  /** 专用动作明确开放的风险（如 install 的 network）；脚本内容推断出的同类风险仍不开放。 */
  enabled?: boolean;
  /** 两种模式下都必须确认（安装依赖、后台常驻进程）。 */
  alwaysConfirm?: boolean;
  /** 常驻进程（dev server / watch）：就绪后先返回，进程在后台继续运行，直到止令。 */
  background?: boolean;
  /** 生成命令时工作目录（或其上级）是否已有 node_modules；用于失败时提示安装依赖。 */
  dependenciesInstalled?: boolean;
  display: {
    /** 给用户看的命令，例如 npm run test。 */
    command: string;
    /** 脚本实际内容（含 pre/post 钩子），按执行顺序。 */
    scripts?: Array<{ name: string; body: string }>;
    scriptSource?: string;
    effects: string[];
  };
  /** 确认后再次核对；返回值与确认前不同即视为内容有异。 */
  fingerprint: () => Promise<string>;
  parse?: (output: { stdout: string; stderr: string; exitCode: number | null }) => Diagnostics | undefined;
};

export type Diagnostic = { file?: string; line?: number; severity?: 'error' | 'warning'; message: string };
export type Diagnostics = {
  passed?: number;
  failed?: number;
  total?: number;
  items: Diagnostic[];
};

export type ActionSpec = {
  id: string;
  /** 风险等级；run_script 的实际等级在 plan() 中按脚本内容确定。 */
  risk: Risk;
  description: string;
  plan(params: Params, context: ActionContext): Promise<ExecPlan>;
};

export interface ToolchainProfile {
  id: string;
  detect(root: vscode.WorkspaceFolder): Promise<ToolchainEnv>;
  /** 返回本工具链可用的动作与动态发现的信息（如 package.json scripts）。 */
  describe(root: vscode.WorkspaceFolder, env: ToolchainEnv): Promise<Record<string, unknown>>;
  actions: ActionSpec[];
}

/** 施行状态；展示层另有中文映射，这里的值不改名。 */
export type RunStatus =
  | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'user_cancelled' | 'approval_timeout'
  | 'timed_out' | 'cancelled' | 'plan_changed' | 'not_enabled' | 'rejected' | 'workspace_untrusted'
  | 'background' | 'stopped';

export type RunResult = {
  status: RunStatus;
  toolchain: string;
  action: string;
  command?: string;
  cwd?: string;
  approved?: 'user' | 'allowlist';
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  diagnostics?: Diagnostics;
  /** 常驻进程检测到的本地访问地址。 */
  url?: string;
  /** DEPENDENCIES_NOT_INSTALLED：失败可能是因为尚未安装依赖。 */
  hint?: string;
  /** logs 动作返回的最近输出。 */
  output?: string;
  alive?: boolean;
  summary: string;
};

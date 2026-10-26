import type { HostFolder, HostUri } from '../host';
import type { RiskLevel, RiskWarning } from './risk';

/**
 * 工具链框架的公共类型。node / git（以后 python / java）都以 Profile 接入，
 * 模型只选择「工具链 + 动作 + 参数」，实际操作由 Profile 生成，扩展按风险等级决定是否放行。
 */

export type ApprovalMode = 'auto' | 'review';
export type Params = Record<string, unknown>;

export type ToolchainEnv = {
  available: boolean;
  version?: string;
  reason?: string;
  [key: string]: unknown;
};

export type ActionContext = {
  root: HostFolder;
  /** 工作区相对目录（以 / 开头），已经过路径校验。 */
  cwd: string;
  cwdUri: HostUri;
  env: ToolchainEnv;
};

/** 不经子进程、由扩展直接完成的操作（Git API、文件操作）。 */
export type NativeOutcome = {
  ok: boolean;
  summary: string;
  code?: string;
  data?: Record<string, unknown>;
};

export type OperationKind = 'command' | 'git' | 'file' | 'external';

/** 一次将要执行的操作；审阅卡片展示的正是这里的内容。 */
export type ExecPlan = {
  kind: OperationKind;
  /** 子进程命令（参数数组，不经 shell）；与 execute 二选一。 */
  argv?: string[];
  execute?: (signal: AbortSignal, input?: { message?: string }) => Promise<NativeOutcome>;
  cwd: string;
  cwdUri: HostUri;
  timeoutMs: number;
  level: RiskLevel;
  /** 白名单键，如 node:test、node:run_script:build、git:status。 */
  allowKey: string;
  /** 风险研判结果；有内容时任何模式都要确认。 */
  warnings?: RiskWarning[];
  /** R4 的拒绝原因。 */
  rejectReason?: string;
  /** 常驻进程（dev server / watch）：就绪后先返回，进程在后台继续运行，直到止令。 */
  background?: boolean;
  /** 生成命令时工作目录（或其上级）是否已有 node_modules；用于失败时提示安装依赖。 */
  dependenciesInstalled?: boolean;
  /** 子进程额外的环境变量（如 Python 虚拟环境的 PATH、VIRTUAL_ENV），在白名单之后合并。 */
  env?: Record<string, string>;
  display: {
    /** 给用户看的命令或操作，例如 npm run test、git commit。 */
    command: string;
    /** 脚本实际内容（含 pre/post 钩子），按执行顺序。 */
    scripts?: Array<{ name: string; body: string }>;
    scriptSource?: string;
    /** 额外说明行：提交说明与文件清单、要删除的路径等。 */
    details?: string[];
    /** 确认时可改写的字段（例如提交说明）。 */
    editable?: { field: 'message'; label: string; value: string };
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
  /** 这个动作通常的风险等级；run_script 等的实际等级在 plan() 中按内容确定。 */
  level: RiskLevel;
  description: string;
  plan(params: Params, context: ActionContext): Promise<ExecPlan>;
};

export interface ToolchainProfile {
  id: string;
  /** cwdDir：命令的工作目录（本机路径），用于查找子项目里的环境（如 Python 的 .venv）。 */
  detect(root: HostFolder, cwdDir?: string): Promise<ToolchainEnv>;
  /** 返回本工具链可用的动作与动态发现的信息（如 package.json scripts）。 */
  describe(root: HostFolder, env: ToolchainEnv): Promise<Record<string, unknown>>;
  actions: ActionSpec[];
}

/** 施行状态；展示层另有中文映射，这里的值不改名。 */
export type RunStatus =
  | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'user_cancelled' | 'approval_timeout'
  | 'timed_out' | 'cancelled' | 'plan_changed' | 'not_enabled' | 'rejected' | 'workspace_untrusted'
  | 'background' | 'stopped' | 'apply_requested';

export type RunResult = {
  status: RunStatus;
  toolchain: string;
  action: string;
  command?: string;
  cwd?: string;
  level?: RiskLevel;
  warnings?: RiskWarning[];
  approved?: 'user' | 'allowlist' | 'auto' | 'remembered';
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
  /** 原生操作（Git、文件）的结构化结果。 */
  data?: Record<string, unknown>;
  code?: string;
  /** 「落笔并施行」：Server 先落笔本轮候选，再凭它继续执行同一条命令。 */
  resumeToken?: string;
  summary: string;
};

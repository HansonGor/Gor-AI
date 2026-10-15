import type { ApprovalMode, ExecPlan } from './types';

export type PolicyDecision =
  | { kind: 'run' }
  | { kind: 'confirm' }
  | { kind: 'reject'; status: 'not_enabled' | 'rejected' | 'workspace_untrusted'; reason: string };

/** Profile 在生成命令时发现不能执行（常驻进程、写入类脚本等），用它带回状态而不是 RPC 失败。 */
export class PlanRejection extends Error {
  constructor(readonly status: 'not_enabled' | 'rejected', message: string) {
    super(message);
    this.name = 'PlanRejection';
  }
}

/** 只开放只读与验证类；联网/写入只对专用动作（如 install）单独开放，脚本内容推断出的仍一律不执行。 */
export const ENABLED_RISKS = new Set(['read', 'verify']);

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  // 只有明确的即刻落笔才放宽；缺失或未知一律按审阅处理。
  return value === 'auto' ? 'auto' : 'review';
}

/**
 * 放行决定只在扩展端做出，不依赖 Server 或模型传来的风险判断。
 * - 未受信任的工作区：任何命令都不执行。
 * - read：直接执行（不运行项目代码）。
 * - 安装依赖、后台常驻进程：两种模式都要确认。
 * - verify：审阅模式每一步确认；即刻模式只有内置白名单直接执行。
 */
export function decide(plan: Pick<ExecPlan, 'risk' | 'allowlisted' | 'enabled' | 'alwaysConfirm'>, mode: ApprovalMode, trusted: boolean): PolicyDecision {
  if (!trusted) {
    return { kind: 'reject', status: 'workspace_untrusted', reason: '当前工作区未受信任，请先在 VS Code 中信任此工作区。' };
  }
  if (!ENABLED_RISKS.has(plan.risk) && plan.enabled !== true) {
    return { kind: 'reject', status: 'not_enabled', reason: '脚本里的安装、联网、删除或发布类命令不会执行；安装依赖请使用 install 动作。' };
  }
  if (plan.risk === 'read') return { kind: 'run' };
  if (plan.alwaysConfirm) return { kind: 'confirm' };
  if (mode === 'auto' && plan.allowlisted) return { kind: 'run' };
  return { kind: 'confirm' };
}

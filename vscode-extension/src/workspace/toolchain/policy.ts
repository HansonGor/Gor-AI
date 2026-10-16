import type { RiskLevel, RiskWarning } from './risk';
import type { ApprovalMode } from './types';

/**
 * 放行策略：等级 × 模式 × 白名单 × 风险研判。
 *
 * |          | 即刻落笔 | 审阅落笔            |
 * | R0 只读   | 直接     | 直接                |
 * | R1 常规   | 直接     | 白名单直接，其余确认 |
 * | R2 删除类 | 确认     | 确认                |
 * | R3 项目外 | 确认     | 确认                |
 * | R4 禁止   | 拒绝     | 拒绝                |
 * 研判出可疑内容时，任何等级都改为确认并显示警告。
 */

export type ConfirmReason = 'review' | 'destructive' | 'external' | 'suspicious';

export type PolicyDecision =
  | { kind: 'run'; approved: 'auto' | 'allowlist' | 'remembered' }
  | { kind: 'confirm'; reason: ConfirmReason; allowRemember: boolean }
  | { kind: 'reject'; status: 'rejected' | 'workspace_untrusted'; reason: string };

/** Profile 在生成操作时发现不能执行，用它带回状态而不是 RPC 失败。 */
export class PlanRejection extends Error {
  constructor(readonly status: 'not_enabled' | 'rejected', message: string) {
    super(message);
    this.name = 'PlanRejection';
  }
}

/** 默认白名单：审阅落笔下也直接运行。可在 VS Code 设置 gor.toolchain.allowlist 中增减。 */
export const DEFAULT_ALLOWLIST = [
  'node:env', 'node:test', 'node:typecheck', 'node:lint',
  'node:run_script:build', 'node:run_script:test', 'node:run_script:lint', 'node:run_script:typecheck',
  'git:status', 'git:diff', 'git:log', 'git:fetch',
];

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  // 只有明确的即刻落笔才放宽；缺失或未知一律按审阅处理。
  return value === 'auto' ? 'auto' : 'review';
}

/** 白名单项可以写完整键，也可以用 * 结尾匹配一类，例如 node:run_script:*。 */
export function isAllowlisted(allowKey: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => entry === allowKey || (entry.endsWith('*') && allowKey.startsWith(entry.slice(0, -1))));
}

export function decide(
  plan: { level: RiskLevel; allowKey: string; warnings?: RiskWarning[]; rejectReason?: string },
  mode: ApprovalMode,
  options: { trusted: boolean; allowlist: readonly string[]; remembered?: boolean },
): PolicyDecision {
  if (!options.trusted) {
    return { kind: 'reject', status: 'workspace_untrusted', reason: '当前工作区未受信任，请先在 VS Code 中信任此工作区。' };
  }
  if (plan.level === 4) return { kind: 'reject', status: 'rejected', reason: plan.rejectReason ?? '这个操作风险过高，Gor 不会执行。' };
  // 可疑内容不能被白名单、即刻模式或「本轮不再询问」绕过。
  if (plan.warnings?.length) return { kind: 'confirm', reason: 'suspicious', allowRemember: false };
  if (plan.level === 0) return { kind: 'run', approved: 'auto' };
  if (plan.level === 2) return { kind: 'confirm', reason: 'destructive', allowRemember: false };
  if (plan.level === 3) return { kind: 'confirm', reason: 'external', allowRemember: false };
  if (isAllowlisted(plan.allowKey, options.allowlist)) return { kind: 'run', approved: 'allowlist' };
  if (mode === 'auto') return { kind: 'run', approved: 'auto' };
  if (options.remembered) return { kind: 'run', approved: 'remembered' };
  return { kind: 'confirm', reason: 'review', allowRemember: true };
}

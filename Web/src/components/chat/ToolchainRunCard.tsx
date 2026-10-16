import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, CircleCheck, CircleX, Clock3, ExternalLink, Folder, FolderOpen, GitBranch, LoaderCircle, Lock, OctagonAlert,
  Play, Radio, ShieldX, SkipForward, SquareTerminal, Trash2, TriangleAlert,
} from 'lucide-react';
import { CONFIRM_REASON_TEXT, toolchainStatusLabel, type ToolchainApproveOptions, type ToolchainRunView } from './toolchainRun';
import './ToolchainRunCard.less';

type Props = {
  run: ToolchainRunView;
  onShown?: () => void;
  onApprove?: (options?: ToolchainApproveOptions) => void;
  onApplyAndRun?: () => void;
  onSkip?: () => void;
  onStopRound?: () => void;
  onAbort?: () => void;
  onOpenUrl?: () => void;
};

const MAX_DETAIL_LINES = 12;

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const StatusIcon = ({ run }: { run: ToolchainRunView }) => {
  const { tone } = toolchainStatusLabel(run);
  if (run.status === 'running') return <LoaderCircle className="toolchain-spin" aria-hidden="true" />;
  if (run.status === 'background') return <Radio aria-hidden="true" />;
  if (tone === 'ok') return <CircleCheck aria-hidden="true" />;
  if (tone === 'fail') return <CircleX aria-hidden="true" />;
  if (run.status === 'workspace_untrusted' || run.status === 'not_enabled') return <Lock aria-hidden="true" />;
  if (tone === 'pending') return <TriangleAlert aria-hidden="true" />;
  return <SkipForward aria-hidden="true" />;
};

function KindIcon({ run, high }: { run: ToolchainRunView; high: boolean }) {
  if (high) return <ShieldX aria-hidden="true" />;
  if (run.kind === 'git') return <GitBranch aria-hidden="true" />;
  if (run.kind === 'file') return <Trash2 aria-hidden="true" />;
  if (run.kind === 'external') return <FolderOpen aria-hidden="true" />;
  return <SquareTerminal aria-hidden="true" />;
}

function WarningTag({ level }: { level?: 'warn' | 'high' }) {
  if (!level) return null;
  return level === 'high'
    ? <span className="toolchain-status-tag tone-fail"><OctagonAlert aria-hidden="true" />高度可疑</span>
    : <span className="toolchain-status-tag tone-pending"><TriangleAlert aria-hidden="true" />疑似风险</span>;
}

/** 施行审阅卡片：只接收 props 与回调，不访问扩展、文件系统或网络。 */
export default function ToolchainRunCard({ run, onShown, onApprove, onApplyAndRun, onSkip, onStopRound, onAbort, onOpenUrl }: Props) {
  const awaiting = run.pending === true && run.status === 'awaiting_approval';
  const now = useNow(awaiting || run.status === 'running');
  const skipRef = useRef<HTMLButtonElement>(null);
  const shownRef = useRef<string | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState(false);
  const [remember, setRemember] = useState(false);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState(run.editable?.value ?? '');

  useEffect(() => {
    if (!awaiting || shownRef.current === run.approvalId) return;
    shownRef.current = run.approvalId;
    onShown?.();
    // 焦点落在「搁置」而不是「施行」，回车不会直接执行。
    skipRef.current?.focus({ preventScroll: true });
  }, [awaiting, run.approvalId, onShown]);

  const { label, tone } = toolchainStatusLabel(run);
  const firstDiagnostic = run.diagnostics?.items?.find((item) => item.file);

  if (!awaiting) {
    const detail = run.status === 'running'
      ? `已 ${clock(now - (run.startedAt ?? now))} · 输出见「Gor 工具链」`
      : run.status === 'background' ? (run.url ? '后台运行中' : run.summary) : run.summary;
    const stoppable = (run.status === 'running' || run.status === 'background') && onAbort;
    return (
      <div className={`toolchain-run-row tone-${tone}`} role="status" aria-label={`${label}：${run.command ?? '命令'}`}>
        <span className="toolchain-row-icon"><StatusIcon run={run} /></span>
        <span className="toolchain-row-copy">
          {run.command && <code className="toolchain-row-command">{run.command}</code>}
          {detail && <span className="toolchain-row-detail">{detail}</span>}
          {run.warningLevel && run.approved === 'user' && run.status !== 'user_cancelled' && (
            <span className="toolchain-row-detail">你已知悉风险并施行</span>
          )}
          {run.status === 'background' && run.url && (
            <button type="button" className="toolchain-row-url" onClick={onOpenUrl} title="在浏览器中打开">
              {run.url}<ExternalLink aria-hidden="true" />
            </button>
          )}
          {firstDiagnostic && (
            <code className="toolchain-row-location">{firstDiagnostic.file}{firstDiagnostic.line ? `:${firstDiagnostic.line}` : ''}</code>
          )}
        </span>
        <WarningTag level={run.warningLevel} />
        {stoppable
          ? <button type="button" className="toolchain-row-abort" onClick={onAbort}>止令</button>
          : <span className={`toolchain-status-tag tone-${tone}`}>{label}</span>}
      </div>
    );
  }

  const busy = run.answering === true;
  const high = run.warnings?.some((warning) => warning.level === 'high') ?? false;
  const blocked = busy || (high && !acknowledged);
  const pendingFiles = run.pendingReviewFiles ?? 0;
  const details = run.details ?? [];
  const approve = () => onApprove?.({
    ...(remember && run.allowRemember ? { remember: true } : {}),
    ...(run.editable && message.trim() && message !== run.editable.value ? { message } : {}),
  });

  return (
    <section
      className={`toolchain-approval-card${high ? ' risk-high' : run.warnings?.length ? ' risk-warn' : ''}`}
      aria-label="此令待你过目"
      onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onSkip?.(); } }}
    >
      <header className="toolchain-approval-head">
        <span className="toolchain-approval-emblem"><KindIcon run={run} high={high} /></span>
        <strong className="toolchain-approval-title">此令待你过目</strong>
        {high ? <WarningTag level="high" /> : <span className="toolchain-status-tag tone-pending">待施行</span>}
      </header>
      {run.reason && <div className="toolchain-approval-reason">{CONFIRM_REASON_TEXT[run.reason]}</div>}

      {run.warnings && run.warnings.length > 0 && (
        <div className={`toolchain-approval-warnings ${high ? 'level-high' : 'level-warn'}`} role="alert">
          <div className="toolchain-warning-title">
            {high ? <OctagonAlert aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
            {high ? `发现 ${run.warnings.filter((w) => w.level === 'high').length} 处高危行为` : '疑似风险'}
          </div>
          {run.warnings.map((warning, index) => (
            <div className="toolchain-warning-item" key={`${warning.reason}-${index}`}>
              <span>{run.warnings!.length > 1 ? `${index + 1}. ` : ''}{warning.reason}</span>
              {warning.evidence && <code>{warning.evidence}</code>}
            </div>
          ))}
          {high && <div className="toolchain-warning-note">这是规则匹配的提示，不代表一定有害；不确定时请先搁置</div>}
        </div>
      )}

      {pendingFiles > 0 && (
        <div className="toolchain-approval-pending">有 {pendingFiles} 个审阅候选尚未落笔，命令将针对落笔前的内容运行</div>
      )}

      <div className="toolchain-approval-command">
        {(run.kind ?? 'command') === 'command' && <span aria-hidden="true">$ </span>}<code>{run.command}</code>
      </div>
      <div className="toolchain-approval-meta">
        <span><Folder aria-hidden="true" />{run.cwd ?? '/'}</span>
      </div>

      {details.length > 0 && (
        <div className="toolchain-approval-details">
          {details.slice(0, MAX_DETAIL_LINES).map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
          {details.length > MAX_DETAIL_LINES && <div>…另有 {details.length - MAX_DETAIL_LINES} 行</div>}
        </div>
      )}

      {run.editable && (
        <div className="toolchain-approval-edit">
          <div className="toolchain-approval-edit-head">
            <span>{run.editable.label}</span>
            <button type="button" disabled={busy} onClick={() => setEditing((value) => !value)}>{editing ? '收起' : '改写'}</button>
          </div>
          {editing
            ? <textarea value={message} maxLength={5000} disabled={busy} aria-label={`改写${run.editable.label}`}
              onChange={(event) => setMessage(event.target.value)} />
            : <div className="toolchain-approval-edit-value">{message || run.editable.value}</div>}
        </div>
      )}

      {run.scripts && run.scripts.length > 0 && (
        <details className="toolchain-approval-scripts" open>
          <summary>
            <ChevronDown aria-hidden="true" />令文原貌
            {run.scriptSource && <small>{run.scriptSource}</small>}
          </summary>
          {run.scripts.map((script) => (
            <div className="toolchain-approval-script" key={script.name}>
              {run.scripts!.length > 1 && <span className="toolchain-script-name">{script.name}</span>}
              <code>{script.body}</code>
            </div>
          ))}
        </details>
      )}
      {run.effects && run.effects.length > 0 && (
        <div className="toolchain-approval-effects">
          {run.effects.map((effect) => <span key={effect}>{effect}</span>)}
        </div>
      )}

      {run.allowRemember && (
        <label className="toolchain-approval-check">
          <input type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
          本轮内此命令不再询问
        </label>
      )}
      {high && (
        <label className="toolchain-approval-check is-risk">
          <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />
          我已看过以上风险，仍要施行
        </label>
      )}

      <div className="toolchain-approval-actions">
        <button ref={skipRef} type="button" className="toolchain-approval-skip" disabled={busy} onClick={onSkip}>
          <SkipForward aria-hidden="true" />搁置
        </button>
        <button type="button" className={`toolchain-approval-run${high ? ' is-risk' : ''}`} disabled={blocked} aria-busy={busy} onClick={approve}>
          {busy ? <LoaderCircle className="toolchain-spin" aria-hidden="true" /> : high && !acknowledged ? <Lock aria-hidden="true" /> : <Play aria-hidden="true" />}
          {pendingFiles > 0 ? '仅施行' : '施行'}
        </button>
      </div>
      {pendingFiles > 0 && onApplyAndRun && (
        <button type="button" className="toolchain-approval-apply" disabled={blocked} onClick={onApplyAndRun}>
          落笔并施行
        </button>
      )}
      <div className="toolchain-approval-footer">
        {run.deadline ? <span><Clock3 aria-hidden="true" />{clock(run.deadline - now)} 后未允准，自动搁置</span> : <span />}
        <button type="button" className="toolchain-approval-stop" disabled={busy} onClick={onStopRound}>就此收笔</button>
      </div>
    </section>
  );
}

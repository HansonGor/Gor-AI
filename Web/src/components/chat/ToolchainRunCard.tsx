import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, CircleCheck, CircleX, Clock3, ExternalLink, Folder, LoaderCircle, Lock, Play, Radio, SkipForward, SquareTerminal, TriangleAlert,
} from 'lucide-react';
import { toolchainStatusLabel, type ToolchainRunView } from './toolchainRun';
import './ToolchainRunCard.less';

type Props = {
  run: ToolchainRunView;
  onShown?: () => void;
  onApprove?: () => void;
  onSkip?: () => void;
  onStopRound?: () => void;
  onAbort?: () => void;
  onOpenUrl?: () => void;
};

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

/** 施行审阅卡片：只接收 props 与回调，不访问扩展、文件系统或网络。 */
export default function ToolchainRunCard({ run, onShown, onApprove, onSkip, onStopRound, onAbort, onOpenUrl }: Props) {
  const awaiting = run.pending === true && run.status === 'awaiting_approval';
  const now = useNow(awaiting || run.status === 'running');
  const skipRef = useRef<HTMLButtonElement>(null);
  const shownRef = useRef<string | undefined>(undefined);

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
          {run.status === 'background' && run.url && (
            <button type="button" className="toolchain-row-url" onClick={onOpenUrl} title="在浏览器中打开">
              {run.url}<ExternalLink aria-hidden="true" />
            </button>
          )}
          {firstDiagnostic && (
            <code className="toolchain-row-location">{firstDiagnostic.file}{firstDiagnostic.line ? `:${firstDiagnostic.line}` : ''}</code>
          )}
        </span>
        {stoppable
          ? <button type="button" className="toolchain-row-abort" onClick={onAbort}>止令</button>
          : <span className={`toolchain-status-tag tone-${tone}`}>{label}</span>}
      </div>
    );
  }

  const busy = run.answering === true;
  return (
    <section
      className="toolchain-approval-card"
      aria-label="此令待你过目"
      onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onSkip?.(); } }}
    >
      <header className="toolchain-approval-head">
        <span className="toolchain-approval-emblem"><SquareTerminal aria-hidden="true" /></span>
        <strong className="toolchain-approval-title">此令待你过目</strong>
        <span className="toolchain-status-tag tone-pending">待施行</span>
      </header>
      <div className="toolchain-approval-command"><span aria-hidden="true">$</span> <code>{run.command}</code></div>
      <div className="toolchain-approval-meta">
        <span><Folder aria-hidden="true" />{run.cwd ?? '/'}</span>
      </div>
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
      <div className="toolchain-approval-actions">
        <button ref={skipRef} type="button" className="toolchain-approval-skip" disabled={busy} onClick={onSkip}>
          <SkipForward aria-hidden="true" />搁置
        </button>
        <button type="button" className="toolchain-approval-run" disabled={busy} aria-busy={busy} onClick={onApprove}>
          {busy ? <LoaderCircle className="toolchain-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}施行
        </button>
      </div>
      <div className="toolchain-approval-footer">
        {run.deadline ? <span><Clock3 aria-hidden="true" />{clock(run.deadline - now)} 后未允准，自动搁置</span> : <span />}
        <button type="button" className="toolchain-approval-stop" disabled={busy} onClick={onStopRound}>就此收笔</button>
      </div>
    </section>
  );
}

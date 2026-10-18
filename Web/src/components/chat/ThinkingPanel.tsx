import { useEffect, useState, type ReactNode } from 'react';
import { Brain, BookOpenCheck, ChevronDown, History, LoaderCircle } from 'lucide-react';
import type { ThinkingTrace, ThinkingRound, ResolvedThinkingMode } from '../../utils/thinking';
import { getThinkingIcon } from '../../utils/thinkingIcons';
import './ThinkingPanel.less';

// Retain closing nodes until the grid track has finished shrinking.
function Fold({ open, children, className = '', persistent = false }: { open: boolean; children: ReactNode; className?: string; persistent?: boolean }) {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) { setRetained(true); return; }
    const timer = setTimeout(() => setRetained(false), 260);
    return () => clearTimeout(timer);
  }, [open]);
  return <div className={`thinking-fold ${open ? 'is-open' : ''} ${className}`} aria-hidden={!open} ref={node => { node?.toggleAttribute('inert', !open); }}>
    <div className="thinking-fold-inner">{(persistent || open || retained) && children}</div>
  </div>;
}

function Round({ round, latest = false, resetKey }: { round: ThinkingRound; latest?: boolean; resetKey: string }) {
  const [disclosure, setDisclosure] = useState({ key: '', open: false });
  const open = disclosure.key === resetKey ? disclosure.open : latest;
  const running = latest; // A model-call end is not the Agent's terminal state.
  const summary = round.summary?.trim();
  const heading = round.title?.trim() || '思考中';
  const { Icon, name } = getThinkingIcon(round);
  const details = (round.steps ?? []).filter(step => step.trim() && step !== summary);
  return <div className={`thinking-card ${latest ? 'thinking-latest' : ''}`}>
    <button type="button" className="thinking-heading" aria-expanded={open}
      onClick={() => setDisclosure({ key: resetKey, open: !open })}>
      <span key={name} className="thinking-kind-icon"><Icon size={18} strokeWidth={1.7} aria-hidden="true" /></span>
      <span className="thinking-copy"><strong key={heading} className="thinking-title">{heading}</strong></span>
      {running && <LoaderCircle className="thinking-spinner" aria-hidden="true" />}
      <ChevronDown className={open ? 'is-expanded' : ''} aria-hidden="true" />
    </button>
    <Fold open={open && Boolean(summary || details.length)} persistent>
      {(summary || details.length > 0) && <div className="thinking-content">
        {summary && <p className="thinking-summary">{summary}</p>}
        {details.map((step, index) => <p key={index}>{step}</p>)}
      </div>}
    </Fold>
  </div>;
}

/** 酌思本轮实际采用的深浅，例如"酌思 · 本轮随思（联网新闻）"。 */
export function describeThinkingMode(mode: ResolvedThinkingMode): string {
  const reason = mode.reason ? `（${mode.reason}）` : '';
  return mode.escalated ? `酌思 · 由随思转为深思${reason}` : `酌思 · 本轮${mode.mode === 'deep' ? '深思' : '随思'}${reason}`;
}

export default function ThinkingPanel({ trace }: { trace: ThinkingTrace }) {
  const latestId = trace.rounds[trace.rounds.length - 1]?.id;
  const [disclosure, setDisclosure] = useState({ key: '', open: false });
  if (!latestId) return null;
  const running = trace.status === 'running';
  const key = running ? `running:${latestId}` : `terminal:${trace.status}`;
  const open = disclosure.key === key && disclosure.open;
  const toggle = () => setDisclosure({ key, open: !open });
  const title = trace.status === 'completed' ? '思考已完成' : trace.status === 'failed' ? '思考未完成' : trace.status === 'cancelled' ? '思考已取消' : '思考已中断';
  const StatusIcon = trace.status === 'completed' ? BookOpenCheck : Brain;
  return <section className="thinking-panel" aria-label="思考记录">
    {trace.thinkingMode && <p className="thinking-mode-note">{describeThinkingMode(trace.thinkingMode)}</p>}
    <Fold open={running} className="thinking-running">
      <Fold open={trace.rounds.length > 1} persistent className="thinking-previous-fold"><div className="thinking-card thinking-previous">
        <button type="button" className="thinking-heading" aria-expanded={running && open} onClick={toggle}>
          <History aria-hidden="true" /><span className="thinking-copy">此前思考 · {trace.rounds.length - 1} 条</span><ChevronDown className={running && open ? 'is-expanded' : ''} aria-hidden="true" />
        </button>
      </div></Fold>
      <div className="thinking-rounds">{trace.rounds.map(round => <Fold key={round.id} persistent className="thinking-round-shell" open={running && (round.id === latestId || open)}>
        <Round round={round} latest={running && round.id === latestId} resetKey={key} />
      </Fold>)}</div>
    </Fold>
    {!running && <Fold open className="thinking-round-shell"><div className="thinking-card thinking-finished">
      <button type="button" className="thinking-heading" aria-expanded={open} onClick={toggle}>
        <span className={`thinking-kind-icon ${trace.status === 'completed' ? 'thinking-completion-icon' : ''}`}><StatusIcon size={trace.status === 'completed' ? 20 : 18} strokeWidth={1.7} aria-hidden="true" /></span><span className="thinking-copy"><strong>{title}</strong><small>共 {trace.rounds.length} 轮思考</small></span><ChevronDown className={open ? 'is-expanded' : ''} aria-hidden="true" />
      </button>
      <Fold open={open} className="thinking-terminal-history"><div className="thinking-history">{trace.rounds.map(round => <Round key={round.id} round={round} resetKey={key} />)}</div></Fold>
    </div></Fold>}
  </section>;
}

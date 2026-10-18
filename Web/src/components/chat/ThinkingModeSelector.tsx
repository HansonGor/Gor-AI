import { useCallback, useId, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, Eye, EyeOff, Lightbulb, LoaderCircle, Scale } from 'lucide-react';
import { usePopoverDismiss } from './usePopoverDismiss';
import './FileEditModeSelector.less';
import './ThinkingModeSelector.less';

export type ThinkingModeValue = 'auto' | 'light' | 'deep';
const modes = [
  { value: 'auto' as const, name: '酌思', tag: '（auto）', description: '视问题轻重自定深浅：简单即答，遇到难题自动转为深思。', Icon: Scale },
  { value: 'light' as const, name: '随思', tag: '', description: '不做深度推理，直接作答，更快。', Icon: Lightbulb },
  { value: 'deep' as const, name: '深思', tag: '', description: '先深度推理再作答，更周全，稍慢。', Icon: Brain },
];

/** 纯展示组件：思考方式与"显示思考过程"均由宿主通过 props/回调提供与保存。 */
export default function ThinkingModeSelector({ value, onChange, loading = false, showThinking = true, onShowThinkingChange }: {
  value?: ThinkingModeValue;
  loading?: boolean;
  onChange?: (mode: ThinkingModeValue) => void;
  showThinking?: boolean;
  onShowThinkingChange?: (show: boolean) => void;
}) {
  const [localValue, setLocalValue] = useState<ThinkingModeValue>('auto');
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const selected = modes.find((mode) => mode.value === (value ?? localValue)) ?? modes[0];
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), container, trigger);
  return <div ref={container} className="file-edit-mode-selector thinking-mode-selector">
    <button ref={trigger} type="button" className="file-edit-mode-trigger" aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? panelId : undefined}
      aria-label={`思考方式：${selected.name}${selected.tag}${showThinking ? '' : '，已隐藏思考过程'}`}
      disabled={loading} aria-busy={loading}
      onClick={() => setOpen((current) => !current)}>
      <selected.Icon aria-hidden="true" /><span>{selected.name}{selected.tag && <span className="thinking-mode-tag">{selected.tag}</span>}</span>
      {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>
    {open && <section id={panelId} role="dialog" aria-label="思考方式" className="file-edit-mode-popover">
      <h2>思考方式</h2>
      <div role="radiogroup" aria-label="思考方式">
        {modes.map(({ value: mode, name, tag, description, Icon }, index) => <button key={mode}
          type="button" role="radio" aria-checked={selected.value === mode}
          disabled={loading}
          className={`file-edit-mode-option${selected.value === mode ? ' is-selected' : ''}`}
          onKeyDown={(event) => {
            if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
              event.preventDefault();
              container.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[(index + 1) % modes.length]?.focus();
            }
          }}
          onClick={() => {
            setLocalValue(mode); onChange?.(mode); setOpen(false); trigger.current?.focus();
          }}>
          <Icon aria-hidden="true" />
          <span className="file-edit-mode-copy"><strong>{name}{tag && <span className="thinking-mode-tag">{tag}</span>}</strong><span>{description}</span></span>
          {selected.value === mode ? <Check className="file-edit-mode-check" aria-hidden="true" /> : <span className="file-edit-mode-circle" aria-hidden="true" />}
        </button>)}
      </div>
      <div className="thinking-mode-divider" aria-hidden="true" />
      <button type="button" role="switch" aria-checked={showThinking} className="thinking-mode-visibility"
        onClick={() => onShowThinkingChange?.(!showThinking)}>
        {showThinking ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        <span className="file-edit-mode-copy"><strong>显示思考过程</strong><span>关闭后只显示答复，思考照常进行。</span></span>
        <span className={`thinking-mode-switch${showThinking ? ' is-on' : ''}`} aria-hidden="true" />
      </button>
    </section>}
  </div>;
}

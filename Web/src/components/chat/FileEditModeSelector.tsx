import { useCallback, useId, useRef, useState } from 'react';
import { BookOpenCheck, Check, ChevronDown, Feather, LoaderCircle } from 'lucide-react';
import { usePopoverDismiss } from './usePopoverDismiss';
import './FileEditModeSelector.less';

export type FileEditMode = 'instant' | 'review';
const modes = [
  { value: 'instant' as const, name: '即刻落笔', description: '修改即刻生效，仍可随时复原。', Icon: Feather },
  { value: 'review' as const, name: '审阅落笔', description: '先览改动，确认后再落笔。', Icon: BookOpenCheck },
];

/** Presentation-only selection. The host may supply a controlled value/callback. */
export default function FileEditModeSelector({ value, onChange, loading = false }: {
  value?: FileEditMode;
  loading?: boolean;
  onChange?: (mode: FileEditMode) => void;
}) {
  const [localValue, setLocalValue] = useState<FileEditMode>('instant');
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const selected = modes.find((mode) => mode.value === (value ?? localValue)) ?? modes[0];
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), container, trigger);
  return <div ref={container} className="file-edit-mode-selector">
    <button ref={trigger} type="button" className="file-edit-mode-trigger" aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? panelId : undefined}
      disabled={loading} aria-busy={loading}
      onClick={() => setOpen((current) => !current)}>
      <selected.Icon aria-hidden="true" /><span>{selected.name}</span>
      {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>
    {open && <section id={panelId} role="dialog" aria-label="文件修改方式" className="file-edit-mode-popover">
      <h2>文件修改方式</h2>
      <div role="radiogroup" aria-label="文件修改方式">
        {modes.map(({ value: mode, name, description, Icon }, index) => <button key={mode}
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
          <span className="file-edit-mode-copy"><strong>{name}</strong><span>{description}</span></span>
          {selected.value === mode ? <Check className="file-edit-mode-check" aria-hidden="true" /> : <span className="file-edit-mode-circle" aria-hidden="true" />}
        </button>)}
      </div>
    </section>}
  </div>;
}

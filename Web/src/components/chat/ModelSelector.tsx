import { useCallback, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, LoaderCircle, Lock } from 'lucide-react';
import { usePopoverDismiss } from './usePopoverDismiss';
import './FileEditModeSelector.less';
import './ThinkingModeSelector.less';

export type ModelOption = {
  id: string;
  name: string;
  providerName: string;
  description: string;
  supports_tools: boolean;
  supports_thinking: boolean;
  available: boolean;
};

/** 纯展示组件：模型列表、当前选择与保存都由宿主通过 props/回调提供。 */
export default function ModelSelector({ models, value, onChange, loading = false }: {
  models: ModelOption[];
  value?: string | null;
  loading?: boolean;
  onChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  usePopoverDismiss(open, useCallback(() => setOpen(false), []), container, trigger);
  if (!models.length) return null;
  const selected = models.find(model => model.id === value) ?? models[0];
  return <div ref={container} className="file-edit-mode-selector model-selector">
    <button ref={trigger} type="button" className="file-edit-mode-trigger" aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`模型：${selected.name}`}
      title={selected.name} disabled={loading} aria-busy={loading}
      onClick={() => setOpen(current => !current)}>
      <Cpu aria-hidden="true" /><span className="model-selector-name">{selected.name}</span>
      {loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
    </button>
    {open && <section id={panelId} role="dialog" aria-label="模型" className="file-edit-mode-popover model-selector-popover">
      <h2>模型</h2>
      <div role="radiogroup" aria-label="模型">
        {models.map(model => {
          const isSelected = model.id === selected.id;
          const reason = model.available ? '' : (!model.supports_tools ? '不支持工具调用，暂不可用' : '提供方尚未接入，暂不可用');
          return <button key={model.id} type="button" role="radio" aria-checked={isSelected}
            aria-disabled={!model.available} disabled={loading || !model.available}
            title={reason || undefined}
            className={`file-edit-mode-option${isSelected ? ' is-selected' : ''}${model.available ? '' : ' is-unavailable'}`}
            onKeyDown={event => {
              if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault();
                const radios = [...(container.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])') ?? [])];
                const index = radios.indexOf(event.currentTarget);
                radios[(index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? radios.length - 1 : 1)) % radios.length]?.focus();
              }
            }}
            onClick={() => {
              if (!model.available) return;
              onChange?.(model.id); setOpen(false); trigger.current?.focus();
            }}>
            <Cpu aria-hidden="true" />
            <span className="file-edit-mode-copy"><strong>{model.name}</strong></span>
            {!model.available ? <Lock className="file-edit-mode-check" aria-hidden="true" />
              : isSelected ? <Check className="file-edit-mode-check" aria-hidden="true" />
                : <span className="file-edit-mode-circle" aria-hidden="true" />}
          </button>;
        })}
      </div>
    </section>}
  </div>;
}

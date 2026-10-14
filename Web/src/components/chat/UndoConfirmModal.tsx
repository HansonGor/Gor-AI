import { Layers, LoaderCircle, Undo2, X } from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import './UndoConfirmModal.less';

type Props = {
  open: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
} & ({ mode: 'single'; path: string } | { mode: 'batch'; count: number });

/** Shared confirmation only: the caller owns ChangeSet state and all IO. */
export default function UndoConfirmModal(props: Props) {
  const batch = props.mode === 'batch';
  return <AlertDialog open={props.open} onOpenChange={(open) => { if (!props.busy) props.onOpenChange(open); }}>
    <AlertDialogContent className="undo-confirm-modal" overlayClassName="undo-confirm-overlay"
      onEscapeKeyDown={(event) => { if (props.busy) event.preventDefault(); }}>
      <Button type="button" variant="ghost" size="icon" className="undo-confirm-close" aria-label="关闭复原确认"
        disabled={props.busy} onClick={() => props.onOpenChange(false)}><X aria-hidden="true" /></Button>
      <div className="undo-confirm-visual" aria-hidden="true">
        <span className="undo-confirm-cloud undo-confirm-cloud-left" />
        <span className="undo-confirm-emblem">{batch ? <Layers /> : <Undo2 />}</span>
        <span className="undo-confirm-cloud undo-confirm-cloud-right" />
      </div>
      <AlertDialogTitle className="undo-confirm-title">{batch ? '此番笔墨，是否悉数收回？' : '是否复原此番改动？'}</AlertDialogTitle>
      {!batch && <div className="undo-confirm-path">{props.path}</div>}
      <AlertDialogDescription className="undo-confirm-description">
        {batch ? <>共涉 <strong>{props.count}</strong> 卷，皆将复归落笔前的模样。</> : '将此番复原至落笔前的版本。'}
      </AlertDialogDescription>
      <div className="undo-confirm-actions">
        <AlertDialogCancel className="undo-confirm-cancel" disabled={props.busy}>暂且保留</AlertDialogCancel>
        <AlertDialogAction className="undo-confirm-submit" disabled={props.busy || (batch && props.count === 0)}
          aria-busy={props.busy} onClick={(event) => { event.preventDefault(); if (!props.busy) props.onConfirm(); }}>
          {props.busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          {props.busy ? '正复原' : '复归如初'}
        </AlertDialogAction>
      </div>
    </AlertDialogContent>
  </AlertDialog>;
}

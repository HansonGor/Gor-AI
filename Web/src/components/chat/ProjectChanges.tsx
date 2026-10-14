import CodeDiff from './CodeDiff';
import UndoConfirmModal from './UndoConfirmModal';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, ChevronRight, CircleCheck, LoaderCircle, Undo2 } from 'lucide-react';
import { Button } from '../ui/button';
import { presentDiff } from './diffPresentation';
import { chineseCount } from '../../utils/chineseCount';
import type { ChangeSet, UndoResult } from '../../api/projectChanges';
import './ProjectChanges.less';

export type ChangeDisplayStatus = 'pending' | 'changed' | 'reverted' | 'rejected' | 'applying' | 'undoing' | 'failed' | 'conflict';
const statusLabels = { pending: '待落笔', changed: '已落笔', reverted: '已复原', rejected: '未落笔',
  applying: '正落笔', undoing: '正复原', failed: '未落成', conflict: '内容有异' } as const;
function fileBadge(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const known = ['jsx', 'tsx', 'html', 'css', 'js', 'ts', 'json', 'md'];
  return { type: known.includes(extension) ? extension : 'file', text: known.includes(extension) ? extension.toUpperCase() : 'FILE' };
}
function undoFailureReason(code?: string): string {
  if (code === 'FILE_HAS_UNSAVED_CHANGES') return '存在未保存编辑';
  if (code === 'HASH_CONFLICT' || code === 'VERSION_CONFLICT') return '内容有异';
  if (code === 'WORKSPACE_ROOT_CONFLICT') return '工作区已变化';
  if (code === 'FILE_SAVE_FAILED') return '保存失败';
  return '复原失败';
}

export interface ProjectChangesProps {
  changes: ReadonlyArray<{ path: string; diff?: string; displayStatus?: ChangeDisplayStatus }>;
  title: string;
  label: string;
  restored?: boolean;
  allowSplit?: boolean;
  changeSetId?: string;
  changeClient?: {
    getChangeSet: (id: string) => Promise<ChangeSet>;
    undoFile: (id: string, fileId: string) => Promise<UndoResult>;
    undoChangeSet: (id: string) => Promise<UndoResult>;
    applyFile?: (id: string, fileId: string) => Promise<UndoResult>;
    applyChangeSet?: (id: string) => Promise<UndoResult>;
  };
  onNotify?: (message: string, tone?: 'success' | 'error') => void;
}

/** Shared presentation only: the host supplies changes, never a filesystem API. */
export default function ProjectChanges({ changes, label, allowSplit = true, changeSetId, changeClient, onNotify }: ProjectChangesProps) {
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [loadingFileId, setLoadingFileId] = useState<string | null>(null);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [applyingFileId, setApplyingFileId] = useState<string | null>(null);
  const [applyingBatch, setApplyingBatch] = useState(false);
  const [undoTarget, setUndoTarget] = useState<{ changeSetId: string; fileId?: string; path?: string } | null>(null);
  const inFlight = useRef(false);
  const models = useMemo(() => changes.map((change) => change.diff ? presentDiff(change.diff) : null), [changes]);
  useEffect(() => {
    let active = true;
    setChangeSet(null);
    setUndoTarget(null);
    if (!changeSetId || !changeClient) return () => { active = false; };
    void changeClient.getChangeSet(changeSetId).then((record) => {
      if (active) setChangeSet(record);
    }).catch((error: unknown) => {
      if (active) onNotify?.(error instanceof Error ? error.message : '读取文件变更状态失败。', 'error');
    });
    return () => { active = false; };
  }, [changeSetId, changeClient, onNotify]);
  if (!changes.length) return null;
  // Display metadata only. Existing receipts describe already-applied changes;
  // do not invent pending/reverted states for real files or persist UI state.
  const fileRecords = new Map((changeSet?.files ?? []).map((file) => [file.path, file]));
  const getDisplayStatus = (path: string, fallback?: ChangeDisplayStatus): ChangeDisplayStatus => {
    const status = fileRecords.get(path)?.status;
    if (status === 'pending') return 'pending';
    if (status === 'reverted' || status === 'undone') return 'reverted';
    if (status === 'applying' || status === 'undoing' || status === 'rejected' || status === 'conflict') return status;
    if (status === 'failed' || status === 'undo_failed') return 'failed';
    if (status) return 'changed';
    return fallback ?? 'changed';
  };
  const counts = { pending: 0, changed: 0, reverted: 0, rejected: 0, applying: 0, undoing: 0, failed: 0, conflict: 0 };
  for (const change of changes) counts[getDisplayStatus(change.path, change.displayStatus)] += 1;
  const appliedCount = changeSet?.files.filter((file) => file.status === 'applied').length ?? 0;
  if (changeSet) {
    counts.pending = changeSet.files.filter((file) => file.status === 'pending').length;
    counts.changed = appliedCount;
    counts.reverted = changeSet.files.filter((file) => file.status === 'reverted' || file.status === 'undone').length;
  }
  const canUndo = Boolean(changeSetId && changeClient && changeSet?.sealed);
  const applying = applyingBatch || applyingFileId !== null;
  const canApply = canUndo && Boolean(changeClient?.applyFile && changeClient?.applyChangeSet);
  const runApply = async (fileId?: string) => {
    if (!canApply || !changeSetId || !changeClient || !changeSet || inFlight.current) return;
    if (!changeSet.files.some(file => file.status === 'pending' && (!fileId || file.id === fileId))) return;
    inFlight.current = true;
    if (fileId) setApplyingFileId(fileId); else setApplyingBatch(true);
    try {
      const result = fileId ? await changeClient.applyFile!(changeSetId, fileId) : await changeClient.applyChangeSet!(changeSetId);
      setChangeSet(await changeClient.getChangeSet(changeSetId));
      if (!result.success || result.previewSynced === false) {
        const failures = result.results.filter(file => !file.success);
        onNotify?.(failures.map(file => `${file.path}（${file.code === 'VERSION_CONFLICT' || file.code === 'HASH_CONFLICT' ? '内容有异' : file.code === 'FILE_SAVE_FAILED' ? '保存失败' : '未落成'}）`).join('、') || '文件变更请求失败。', 'error');
      }
    } catch (error) {
      try { setChangeSet(await changeClient.getChangeSet(changeSetId)); } catch { /* confirmed state only */ }
      onNotify?.(error instanceof Error ? error.message : '文件变更请求失败。', 'error');
    } finally {
      inFlight.current = false;
      setApplyingFileId(null);
      setApplyingBatch(false);
    }
  };
  const runUndo = async (fileId?: string) => {
    if (!changeSetId || !changeClient || !changeSet?.sealed || inFlight.current) return;
    const file = fileId ? changeSet.files.find((item) => item.id === fileId) : null;
    if (fileId && (!file || file.status !== 'applied')) return;
    if (!fileId && !changeSet.files.some((item) => item.status === 'applied')) return;
    inFlight.current = true;
    if (fileId) setLoadingFileId(fileId);
    else setLoadingBatch(true);
    try {
      const result = fileId
        ? await changeClient.undoFile(changeSetId, fileId)
        : await changeClient.undoChangeSet(changeSetId);
      const latest = await changeClient.getChangeSet(changeSetId);
      setChangeSet(latest);
      const failures = result.results.filter((item) => !item.success);
      if (!result.success || failures.length) {
        const details = failures.map((item) => item.path
          ? `${item.path}（${undoFailureReason(item.code)}）`
          : undoFailureReason(item.code)).join('、');
        onNotify?.(details ? `复原未完全完成：${details}` : '文件复原失败，请检查文件版本后重试。', 'error');
      } else if (result.previewSynced === false) {
        onNotify?.('文件已恢复，但预览期间发生了新修改，未覆盖当前预览。请同步后查看。', 'error');
      } else {
        const restoredCount = result.results.filter((item) => item.success).length;
        onNotify?.(fileId ? '文件已复原。' : `已复原${restoredCount}卷。`, 'success');
      }
    } catch (error) {
      // A failed/ambiguous response must never be presented as a successful undo.
      try { setChangeSet(await changeClient.getChangeSet(changeSetId)); } catch { /* keep last confirmed state */ }
      onNotify?.(error instanceof Error ? error.message : '文件复原失败。', 'error');
    } finally {
      inFlight.current = false;
      setLoadingFileId(null);
      setLoadingBatch(false);
      setUndoTarget(null);
    }
  };
  return (
    <div className="project-changes" aria-label={label}>
      <div className="project-changes-toolbar">
        <div className="project-changes-title">此番落笔 · {chineseCount(changes.length)}卷留痕</div>
        {allowSplit && <div className="code-diff-modes" role="group" aria-label="Diff 展示模式">
          {(['unified', 'split'] as const).map((mode) => <button key={mode} type="button"
            aria-pressed={viewType === mode} onClick={() => setViewType(mode)}>
            {mode === 'unified' ? 'Unified' : 'Split'}
          </button>)}
        </div>}
      </div>
      <div className="project-changes-status-counts">{counts.pending} 待落笔 · {counts.changed} 已落笔 · {counts.reverted} 已复原
        {(['rejected', 'applying', 'undoing', 'failed', 'conflict'] as const).filter((status) => counts[status] > 0)
          .map((status) => <span key={status}> · {counts[status]} {statusLabels[status]}</span>)}
      </div>
      <div className="project-changes-actions">
        <Button type="button" disabled={!canApply || !counts.pending || applying || loadingBatch || loadingFileId !== null}
          aria-busy={applyingBatch} onClick={() => void runApply()} className="project-changes-accept"><CheckCheck aria-hidden="true" />一并落笔 ({counts.pending})</Button>
        <Button type="button" disabled={!canUndo || appliedCount === 0 || applying || loadingBatch || loadingFileId !== null} aria-busy={loadingBatch}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (changeSetId) setUndoTarget({ changeSetId }); }}
          variant="outline" className="project-changes-revert">
          {loadingBatch ? <LoaderCircle className="animate-spin" aria-label="正复原" /> : <Undo2 aria-hidden="true" />}
          {loadingBatch ? '正复原' : '一并复原'} ({changeSet ? appliedCount : counts.changed})
        </Button>
      </div>
      <div className="project-changes-list">
      {changes.map((change, index) => {
        const record = fileRecords.get(change.path);
        const status = getDisplayStatus(change.path, change.displayStatus);
        const undoing = loadingFileId === record?.id;
        const isApplied = canUndo && record?.status === 'applied';
        const isPending = canApply && record?.status === 'pending';
        const fileApplying = applyingFileId === record?.id || (applyingBatch && record?.status === 'pending');
        const badge = fileBadge(change.path);
        return (
        <details key={`${change.path}-${index}`} className="project-change">
          <summary title="展开或收起 Diff">
            <span className="project-change-heading"><ChevronRight className="project-change-chevron" size={18} aria-hidden="true" />
              <span className={`project-change-badge project-change-badge-${badge.type}`} aria-label={`${badge.text} 文件`}>{badge.text}</span>
              <span className="project-change-copy">
                <span className="code-diff-path" title={change.path}>{change.path.split(/[\\/]/).filter(Boolean).pop() ?? change.path}</span>
                <span className={`project-change-status project-change-status-${status}`}>{fileApplying ? '正落笔' : undoing || (loadingBatch && record?.status === 'applied') ? '正复原' : statusLabels[status]}</span>
              </span>
              {models[index] && <span className="code-diff-stats sr-only" aria-label={`新增 ${models[index]!.additions} 行，删除 ${models[index]!.deletions} 行`}>
                <span className="code-diff-added">+{models[index]!.additions}</span>
                <span className="code-diff-deleted">−{models[index]!.deletions}</span>
              </span>}
            </span>
            {status === 'reverted'
              ? <span className="project-change-complete" role="img" aria-label="已复原完成"><CircleCheck aria-hidden="true" /></span>
              : <Button type="button" disabled={(!isApplied && !isPending) || applying || loadingBatch || loadingFileId !== null} aria-busy={undoing || fileApplying}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (record?.status === 'pending') void runApply(record.id); else if (record && changeSetId) setUndoTarget({ changeSetId, fileId: record.id, path: record.path }); }}
                variant="outline" className="project-change-action">
                {fileApplying ? <LoaderCircle className="animate-spin" aria-label="正落笔" />
                  : undoing ? <LoaderCircle className="animate-spin" aria-label="正复原" />
                    : status !== 'pending' && <Undo2 aria-hidden="true" />}
                {fileApplying ? '正落笔' : undoing ? '正复原' : status === 'pending' ? '落笔' : '复原'}
              </Button>}
          </summary>
          {change.diff && <CodeDiff key={change.diff} path={change.path} raw={change.diff} model={models[index]} viewType={allowSplit ? viewType : 'unified'} />}
        </details>
      ); })}
      </div>
      <UndoConfirmModal open={Boolean(undoTarget)} busy={loadingBatch || loadingFileId !== null}
        {...(undoTarget?.fileId ? { mode: 'single' as const, path: undoTarget.path ?? '' } : { mode: 'batch' as const, count: appliedCount })}
        onOpenChange={(open) => { if (!open && !inFlight.current) setUndoTarget(null); }}
        onConfirm={() => { if (undoTarget && undoTarget.changeSetId === changeSetId) void runUndo(undoTarget.fileId); }} />
    </div>
  );
}

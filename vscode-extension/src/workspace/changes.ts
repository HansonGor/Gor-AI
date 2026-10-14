import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { openEditableWorkspaceDocument, createProjectFile, deleteProjectFile } from './files';
import { writeProjectFile } from './edits';
import { normalizeWorkspaceRelativePath, selectWorkspaceRoot, WorkspaceRequestError } from './paths';

type State = { content: string | null; hash: string | null; version: number | null; identity: string; dirty: boolean };
type Change = { id: string; path: string; before: State; after: State };
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Private full-text snapshots for journaling, never the model's bounded read tool. */
export async function inspectFiles(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(params.paths) || params.paths.length > 100) {
    throw new WorkspaceRequestError('INVALID_PATH', '快照路径列表无效。');
  }
  const root = selectWorkspaceRoot(params.root);
  const identity = hash(root.uri.toString());
  const files: Record<string, State> = {};
  let bytes = 0;
  for (const value of params.paths) {
    const path = normalizeWorkspaceRelativePath(value);
    try {
      const file = await openEditableWorkspaceDocument(path, params.root);
      bytes += Buffer.byteLength(file.content, 'utf8');
      if (bytes > 2_000_000) throw new WorkspaceRequestError('FILE_TOO_LARGE', '变更快照超过 2 MB 安全预算，未执行操作。');
      const disk = new TextDecoder().decode(await vscode.workspace.fs.readFile(file.uri));
      files[path] = { content: file.content, hash: hash(file.content), version: file.fileVersion,
        identity, dirty: file.document.isDirty || disk !== file.content };
    } catch (error) {
      if (!(error instanceof WorkspaceRequestError) || error.code !== 'FILE_NOT_FOUND') throw error;
      files[path] = { content: null, hash: null, version: null, identity, dirty: false };
    }
  }
  return { files };
}

export async function validateExpected(params: Record<string, unknown>, expected: Record<string, State>): Promise<void> {
  const current = (await inspectFiles({ root: params.root, paths: Object.keys(expected) })).files as Record<string, State>;
  for (const [path, state] of Object.entries(expected)) {
    const value = current[path];
    if (value.dirty) throw new WorkspaceRequestError('FILE_HAS_UNSAVED_CHANGES', `文件存在未保存或外部改动：${path}`);
    if (value.identity !== state.identity || value.hash !== state.hash || value.version !== state.version) {
      throw new WorkspaceRequestError('VERSION_CONFLICT', `文件在快照后已变化：${path}`);
    }
  }
}

/** Provider execution only: ChangeSet status and batch policy belong to UndoService. */
export async function restoreFiles(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(params.files) || !params.files.length || params.files.length > 100) {
    throw new WorkspaceRequestError('INVALID_PATH', '撤销目标无效。');
  }
  const files = params.files as Change[];
  const expected = Object.fromEntries(files.map(file => [file.path, file.after]));
  await validateExpected(params, expected); // Repeat all preflight at the native boundary.
  const results: Array<Record<string, unknown>> = [];
  for (const file of files) {
    let changed = false;
    try {
      await validateExpected(params, { [file.path]: file.after });
      const args = { path: file.path, root: params.root, content: file.before.content,
        expectedFileVersion: file.after.version };
      if (file.before.content === null) await deleteProjectFile(args);
      else if (file.after.content === null) await createProjectFile(args);
      else await writeProjectFile(args);
      changed = true;
      const actual = (await inspectFiles({ root: params.root, paths: [file.path] })).files as Record<string, State>;
      // Format-on-save must not silently turn a restore into different contents.
      if (actual[file.path].hash !== file.before.hash || actual[file.path].dirty) {
        throw new WorkspaceRequestError('RESTORE_CONTENT_MISMATCH', '保存后内容与撤销快照不一致。');
      }
      results.push({ fileId: file.id, path: file.path, success: true, changed });
    } catch (error) {
      const known = error instanceof WorkspaceRequestError ? error : undefined;
      results.push({ fileId: file.id, path: file.path, success: false,
        changed: changed || known?.code === 'FILE_SAVE_FAILED', code: known?.code ?? 'WORKSPACE_OPERATION_FAILED' });
    }
  }
  return { results };
}

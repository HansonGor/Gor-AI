import asyncio
import copy
import unittest
from contextlib import asynccontextmanager

from project_api.changes import ChangeRecorder, UndoService, snapshot, current_recorder
from project_api.types import ProjectRef, ProjectAPIError
from project_api.providers.preview import PreviewProjectProvider
from project_api.providers.vscode import VSCodeProjectProvider
from services.preview_project_service import PreviewProjectService
from services.preview.workspace import PreviewProjectWorkspace


class Store:
    def __init__(self):
        self.rows, self.locks = {}, {}

    async def put(self, item):
        self.rows[item['id']] = copy.deepcopy(item)

    async def get(self, id):
        return copy.deepcopy(self.rows.get(id))

    @asynccontextmanager
    async def lock(self, id):
        async with self.locks.setdefault(id, asyncio.Lock()):
            yield


class Bridge:
    def __init__(self):
        self.files = {'/a.ts': snapshot('new', 2), '/b.ts': snapshot('new-b', 2)}
        self.fail = None
        self.calls = []

    async def get_workspace_tree(self, *args, **kwargs):
        return {'files': list(self.files)}

    def update_workspace_tree(self, *args):
        pass

    async def call(self, id, method, params):
        self.calls.append(method)
        if method == 'project.inspectFiles':
            return {'files': {p: copy.deepcopy(self.files.get(p, snapshot(None))) for p in params['paths']}}
        if method == 'project.restoreFiles':
            results = []
            for file in params['files']:
                failed = file['path'] == self.fail
                if not failed:
                    self.files[file['path']] = snapshot(file['before']['content'], 3)
                results.append({'fileId': file['id'], 'path': file['path'], 'success': not failed,
                    'changed': failed, 'code': 'FILE_SAVE_FAILED' if failed else None})
            return {'results': results}
        if method == 'project.writeFile':
            path = params['path']
            self.files[path] = snapshot(params['content'], 3)
            if self.fail == path:
                self.files[path]['dirty'] = True
                raise ProjectAPIError('FILE_SAVE_FAILED', 'save failed', {
                    'changeSnapshots': {path: self.files[path]}, 'savedFiles': [], 'changedFiles': [{'path': path, 'diff': 'original diff'}]})
            return {'success': True, 'changeSnapshots': {path: self.files[path]}}
        raise AssertionError(method)


class ChangeTests(unittest.IsolatedAsyncioTestCase):
    async def setup_host(self, host, before=None, after=None):
        self.store = Store()
        self.ref = ProjectRef('vscode-test' if host == 'vscode' else 'p', host)
        before = before or {'/a.ts': 'old', '/b.ts': 'old-b'}
        after = after or {'/a.ts': 'new', '/b.ts': 'new-b'}
        self.recorder = ChangeRecorder(self.store, 'session', 'round')
        item = await self.recorder.record(self.ref,
            {p: snapshot(before.get(p), 1) for p in before.keys() | after.keys()},
            {p: snapshot(after.get(p), 2) for p in before.keys() | after.keys()})
        await self.recorder.seal()
        self.item = item
        if host == 'preview':
            self.workspace = PreviewProjectWorkspace('p', 'react', after.copy(), 2)
            self.provider = PreviewProjectProvider(PreviewProjectService(self.workspace))
        else:
            self.bridge = Bridge()
            self.bridge.files = {p: snapshot(after.get(p), 2) for p in before.keys() | after.keys()}
            self.provider = VSCodeProjectProvider(self.bridge)

        async def factory(ref, record):
            self.assertEqual(ref, self.ref)
            return self.provider
        self.service = UndoService(self.store, factory)

    async def test_single_then_batch_and_repeat_both_hosts(self):
        for host in ['preview', 'vscode']:
            await self.setup_host(host)
            original = copy.deepcopy(self.item['files'][0]['before'])
            after_original = copy.deepcopy(self.item['files'][0]['after'])
            single = await self.service.undoFile(self.item['id'], self.item['files'][0]['id'])
            self.assertTrue(single['success'])
            result = await self.service.undoChangeSet(self.item['id'])
            self.assertTrue(result['success'])
            self.assertEqual(len(result['results']), 1)
            self.assertTrue((await self.service.undoChangeSet(self.item['id']))['unchanged'])
            record = await self.service.getChangeSet(self.item['id'])
            self.assertEqual(record['files'][0]['before'], original)
            self.assertEqual(record['files'][0]['after'], after_original)
            self.assertTrue(all(f['status'] == 'reverted' for f in record['files']))

    async def test_create_delete_restore_both_hosts(self):
        for host in ['preview', 'vscode']:
            await self.setup_host(host, {'/deleted.ts': 'restore'}, {'/created.ts': 'remove'})
            result = await self.service.undoChangeSet(self.item['id'])
            self.assertTrue(result['success'])
            states = await self.provider.inspect_files(self.ref, ['/deleted.ts', '/created.ts'])
            self.assertEqual(states['/deleted.ts']['content'], 'restore')
            self.assertIsNone(states['/created.ts']['content'])

    async def test_batch_hash_or_version_conflict_blocks_all(self):
        for host in ['preview', 'vscode']:
            for version_only in [False, True]:
                await self.setup_host(host)
                if host == 'preview':
                    if version_only:
                        self.workspace.revision += 1
                    else:
                        self.workspace.files['/a.ts'] = 'user text'
                else:
                    self.bridge.files['/a.ts'] = snapshot('new' if version_only else 'user text', 7)
                result = await self.service.undoChangeSet(self.item['id'])
                self.assertFalse(result['success'])
                self.assertEqual(result['code'], 'UNDO_CONFLICT')
                record = await self.service.getChangeSet(self.item['id'])
                self.assertTrue(all(f['status'] == 'applied' for f in record['files']))

    async def test_dirty_partial_failure_and_repeat(self):
        await self.setup_host('vscode')
        self.bridge.files['/a.ts']['dirty'] = True
        self.assertFalse((await self.service.undoChangeSet(self.item['id']))['success'])
        self.bridge.files['/a.ts']['dirty'] = False
        self.bridge.fail = '/b.ts'
        result = await self.service.undoChangeSet(self.item['id'])
        self.assertFalse(result['success'])
        self.assertEqual(sum(r['success'] for r in result['results']), 1)
        record = await self.service.getChangeSet(self.item['id'])
        self.assertEqual({f['status'] for f in record['files']}, {'reverted', 'undo_failed'})
        calls = len(self.bridge.calls)
        self.assertTrue((await self.service.undoChangeSet(self.item['id']))['unchanged'])
        self.assertEqual(len(self.bridge.calls), calls)

    async def test_web_commit_failure_keeps_vfs(self):
        await self.setup_host('preview')
        async def fail(workspace):
            raise ProjectAPIError('VERSION_CONFLICT', 'CAS failed')
        self.provider.commit_restore = fail
        result = await self.service.undoChangeSet(self.item['id'])
        self.assertFalse(result['success'])
        self.assertEqual(self.workspace.files['/a.ts'], 'new')

    async def test_recorder_coalesces_and_provider_auto_records(self):
        await self.setup_host('vscode')
        self.recorder = ChangeRecorder(self.store, 'session')
        token = current_recorder.set(self.recorder)
        try:
            await self.provider.write_file(self.ref, '/a.ts', 'first')
            await self.provider.write_file(self.ref, '/a.ts', 'final')
        finally:
            current_recorder.reset(token)
        await self.recorder.seal()
        record = next(iter(self.recorder.sets.values()))
        self.assertEqual(len(record['files']), 1)
        self.assertEqual(record['files'][0]['before']['content'], 'new')
        self.assertEqual(record['files'][0]['after']['content'], 'final')
        self.assertEqual(record['files'][0]['status'], 'applied')

    async def test_auto_record_save_failure_preserves_diff_and_hides_private_text(self):
        await self.setup_host('vscode')
        recorder = ChangeRecorder(self.store, 'session')
        token = current_recorder.set(recorder)
        self.bridge.fail = '/a.ts'
        try:
            with self.assertRaises(ProjectAPIError) as caught:
                await self.provider.write_file(self.ref, '/a.ts', 'unsaved')
            self.assertNotIn('changeSnapshots', caught.exception.details)
            self.assertEqual(caught.exception.details['changedFiles'][0]['diff'], 'original diff')
        finally:
            current_recorder.reset(token)
        await recorder.seal()
        file = next(iter(recorder.sets.values()))['files'][0]
        self.assertEqual(file['status'], 'failed')
        self.assertEqual(file['after']['content'], 'unsaved')

    async def test_auto_record_multi_root_batch_and_noop_preserve_applied(self):
        await self.setup_host('vscode')
        class RootsBridge(Bridge):
            def __init__(self):
                super().__init__()
                self.roots = {root: {'/a.ts': snapshot('old-' + root, 1)} for root in ['root-1', 'root-2']}
            async def call(self, id, method, params):
                if method == 'project.inspectFiles':
                    return {'files': copy.deepcopy(self.roots[params['root']])}
                if method == 'project.applyPatches':
                    for patch in params['patches']:
                        files = self.roots[patch['root']]
                        files[patch['path']] = snapshot(patch['newText'], 2)
                    return {'success': True, 'savedFiles': ['/a.ts', '/a.ts'], 'fileVersions': {'/a.ts': 2},
                        'changeSnapshotGroups': [{'root': g['root'], 'files': copy.deepcopy(self.roots[g['root']])}
                            for g in params['changeExpectedGroups']]}
                return await super().call(id, method, params)
        provider = VSCodeProjectProvider(RootsBridge())
        recorder = ChangeRecorder(self.store, 'session')
        token = current_recorder.set(recorder)
        try:
            result = await provider.apply_patches(self.ref, [{'path': '/a.ts', 'root': root,
                'old_text': 'old-' + root, 'new_text': 'new-' + root} for root in ['root-1', 'root-2']])
            self.assertNotIn('changeSnapshotGroups', result)
            self.assertEqual(len(recorder.sets), 2)
            for root in ['root-1', 'root-2']:
                item = recorder.sets[('vscode', 'vscode-test', root)]
                self.assertEqual(item['files'][0]['before']['content'], 'old-' + root)
                self.assertEqual(item['files'][0]['after']['content'], 'new-' + root)
        finally:
            current_recorder.reset(token)
        recorder = ChangeRecorder(self.store, 'session')
        token = current_recorder.set(recorder)
        try:
            await self.provider.write_file(self.ref, '/a.ts', 'newer')
            await self.provider.write_file(self.ref, '/a.ts', 'newer')
        finally:
            current_recorder.reset(token)
        self.assertEqual(next(iter(recorder.sets.values()))['files'][0]['status'], 'applied')

    async def test_auto_record_blocks_interleaved_user_edits_and_storage_failure(self):
        await self.setup_host('vscode')
        recorder = ChangeRecorder(self.store, 'session')
        token = current_recorder.set(recorder)
        try:
            await self.provider.write_file(self.ref, '/a.ts', 'first')
            self.bridge.files['/a.ts'] = snapshot('user edit', 4)
            with self.assertRaises(ProjectAPIError):
                await self.provider.write_file(self.ref, '/a.ts', 'second')
            self.assertEqual(self.bridge.files['/a.ts']['content'], 'user edit')
        finally:
            current_recorder.reset(token)
        self.assertEqual(next(iter(recorder.sets.values()))['files'][0]['after']['content'], 'first')

        recorder = ChangeRecorder(self.store, 'session')
        async def fail_put(item):
            raise RuntimeError('database failed')
        self.store.put = fail_put
        token = current_recorder.set(recorder)
        try:
            with self.assertRaises(RuntimeError):
                await self.provider.write_file(self.ref, '/a.ts', 'second')
        finally:
            current_recorder.reset(token)
        self.assertEqual(self.bridge.files['/a.ts']['content'], 'user edit')

    async def test_web_sync_callback_and_history_remain_separate(self):
        await self.setup_host('preview')
        initial = self.workspace.initial_files.copy()
        committed = []
        async def commit(workspace):
            committed.append(workspace.files.copy())
            self.provider.sync_result = {'serverRevision': 3}
        self.provider.commit_restore = commit
        result = await self.service.undoChangeSet(self.item['id'])
        self.assertEqual(result['serverRevision'], 3)
        self.assertEqual(committed[0], {'/a.ts': 'old', '/b.ts': 'old-b'})
        self.assertEqual(self.workspace.initial_files, initial)
        await self.recorder.seal() # Stream finally must not overwrite a just-completed undo.
        record = await self.store.get(self.item['id'])
        self.assertTrue(all(f['status'] == 'reverted' for f in record['files']))

    async def test_post_undo_journal_failure_returns_saved_file_results_without_replay(self):
        await self.setup_host('preview')
        original_put = self.store.put
        async def fail_final(item):
            if any(f['status'] == 'reverted' for f in item['files']):
                raise RuntimeError('DB disconnected after actual IO')
            await original_put(item)
        self.store.put = fail_final
        result = await self.service.undoChangeSet(self.item['id'])
        self.assertFalse(result['success'])
        self.assertEqual(result['code'], 'CHANGE_SET_SAVE_FAILED')
        self.assertTrue(all(r['success'] for r in result['results']))
        self.assertEqual(self.workspace.files['/a.ts'], 'old')
        with self.assertRaises(ProjectAPIError):
            await self.service.undoChangeSet(self.item['id'])

    async def test_jsonb_store_survives_repository_recreation_and_unlocks(self):
        import json
        from unittest.mock import patch
        from db.project_changes import ChangeSetStore
        rows, calls = {}, []
        class Connection:
            async def execute(self, sql, *args):
                calls.append(sql)
                if 'INSERT INTO' in sql:
                    rows[args[0]] = args[2]
            async def fetchval(self, sql, id):
                return rows.get(id)
        class Pool:
            @asynccontextmanager
            async def acquire(self):
                yield Connection()
        async def pool():
            return Pool()
        with patch('db.project_changes.get_pool', pool):
            store = ChangeSetStore()
            await store.put({'id': 'id', 'sessionId': 's', 'files': [{'before': snapshot('中文\n'), 'status': 'applied'}]})
            other = ChangeSetStore()
            self.assertEqual((await other.get('id'))['files'][0]['before']['content'], '中文\n')
            with self.assertRaises(RuntimeError):
                async with other.lock('id'):
                    self.assertEqual(json.loads(rows['id'])['id'], 'id')
                    raise RuntimeError('interrupted')
            self.assertIsNone(other.connection.get())
            self.assertTrue(any('pg_advisory_unlock' in sql for sql in calls))

    async def test_api_session_ownership_and_non_current_web_project(self):
        from unittest.mock import patch
        from fastapi import HTTPException
        from routes import project_changes as api
        await self.setup_host('preview')
        with patch.object(api, 'service', self.service):
            with self.assertRaises(HTTPException) as error:
                await api.get_change_set('other-session', self.item['id'])
            self.assertEqual(error.exception.status_code, 404)
            result = await api.get_change_set('session', self.item['id'])
            self.assertEqual(result['roundId'], 'round')
            result = await api.undo_file('session', self.item['id'], self.item['files'][0]['id'])
            self.assertTrue(result['success'])
        async def different(session):
            return {'project': {'id': 'different'}}
        with patch.object(api, 'get_session_preview_project', different):
            with self.assertRaises(ProjectAPIError) as error:
                await api.provider_factory(self.ref, self.item)
            self.assertEqual(error.exception.code, 'PROJECT_NOT_CURRENT')

    async def test_round_isolation_busy_unknown_and_concurrent_repeat(self):
        await self.setup_host('preview')
        row = await self.store.get(self.item['id'])
        row['sealed'] = False
        await self.store.put(row)
        with self.assertRaisesRegex(ProjectAPIError, '尚未结束'):
            await self.service.undoChangeSet(row['id'])
        row['sealed'] = True
        await self.store.put(row)
        results = await asyncio.gather(self.service.undoChangeSet(row['id']), self.service.undoChangeSet(row['id']))
        self.assertEqual(sum(bool(r.get('unchanged')) for r in results), 1)
        row['files'][0]['status'] = 'undoing'
        await self.store.put(row)
        with self.assertRaisesRegex(ProjectAPIError, '中断'):
            await self.service.undoChangeSet(row['id'])

    async def test_pending_failed_not_undone_invalid_file(self):
        await self.setup_host('preview')
        row = await self.store.get(self.item['id'])
        row['files'][0]['status'], row['files'][1]['status'] = 'pending', 'failed'
        await self.store.put(row)
        self.assertTrue((await self.service.undoChangeSet(row['id']))['unchanged'])
        with self.assertRaises(ProjectAPIError):
            await self.service.undoFile(row['id'], 'other-round-file')

import asyncio
import copy
import unittest
from unittest.mock import patch, AsyncMock
from contextlib import asynccontextmanager
from project_api.changes import ChangeRecorder, UndoService, snapshot, current_recorder
from project_api.review import ApplyService
from project_api.types import ProjectRef, ProjectAPIError
from project_api.providers.preview import PreviewProjectProvider
from project_api.providers.vscode import VSCodeProjectProvider
from services.preview.workspace import PreviewProjectWorkspace
from services.preview_project_service import PreviewProjectService


class Store:
    def __init__(self): self.rows, self.locks = {}, {}
    async def put(self, item): self.rows[item['id']] = copy.deepcopy(item)
    async def get(self, id): return copy.deepcopy(self.rows.get(id))
    @asynccontextmanager
    async def lock(self, id):
        async with self.locks.setdefault(id, asyncio.Lock()): yield


class Bridge:
    def __init__(self):
        self.files = {'/a.ts': snapshot('old', 1), '/b.ts': snapshot('old-b', 1)}
        self.calls, self.fail = [], None
    async def get_workspace_tree(self, *args, **kwargs): return {'files': list(self.files)}
    def update_workspace_tree(self, *args): pass
    async def call(self, id, method, params):
        self.calls.append(method)
        if method == 'project.inspectFiles':
            return {'files': {p: copy.deepcopy(self.files.get(p, snapshot(None))) for p in params['paths']}}
        if method == 'project.restoreFiles':
            results = []
            for f in params['files']:
                failed = f['path'] == self.fail
                if not failed:
                    self.files[f['path']] = snapshot(f['before']['content'], (f['after']['version'] or 0) + 1)
                results.append({'fileId': f['id'], 'path': f['path'], 'success': not failed,
                    'changed': failed, 'code': 'FILE_SAVE_FAILED' if failed else None})
            return {'results': results}
        raise AssertionError(f'Unexpected mutation before confirmation: {method}')


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_preview_single_confirm_keeps_old_preview_until_all_confirmed(self):
        from routes import project_changes as route
        self.store = Store()
        ref = ProjectRef('new', 'preview')
        recorder = ChangeRecorder(self.store, 's', 'r', edit_mode='review')
        paths = ['/index.html', '/src/main.jsx']
        item = await recorder.record(ref, {p: snapshot(None, 0) for p in paths},
            {p: snapshot('new source', 0) for p in paths}, {p: 'pending' for p in paths})
        item.update(previewNewProject=True, previewParentProjectId='old', previewParentRevision=7,
            previewBaseProject={'id': 'new', 'template': 'react', 'files': {}, 'revision': 0},
            previewCandidate={'id': 'new', 'template': 'react', 'name': 'New'}, messageId='assistant')
        await recorder.seal()
        row = {'project': {'id': 'old', 'files': {'/old.html': 'old'}}, 'revision': 7}
        commit = AsyncMock(return_value={'revision': 8})
        service = ApplyService(self.store, route.provider_factory)
        with patch.object(route, 'get_session_preview_project', AsyncMock(return_value=row)), patch.object(route, 'update_session_preview_project_if_revision', commit):
            result = await service.applyFile(item['id'], item['files'][0]['id'])
            self.assertTrue(result['success'])
            self.assertNotIn('previewProject', result)
            commit.assert_not_awaited()
            saved = await self.store.get(item['id'])
            self.assertEqual(len(saved['previewBaseProject']['files']), 1)
            result = await service.applyChangeSet(item['id'])
            self.assertTrue(result['success'])
            self.assertEqual(set(result['previewProject']['files']), set(paths))
            commit.assert_awaited_once()
            published = (await self.store.get(item['id']))['previewPublishedSnapshot']
            self.assertEqual(published['messageId'], 'assistant')
            self.assertEqual(published['files'], result['previewProject']['files'])

    async def test_post_save_inspection_failure_keeps_receipts_and_unknown_intent(self):
        await self.setup_host('vscode')
        await self.pending({'/a.ts': 'new'})
        original = self.provider.restore_files
        async def restore(ref, targets):
            result = await original(ref, targets)
            self.provider.inspect_files = AsyncMock(side_effect=RuntimeError('disconnected'))
            return result
        self.provider.restore_files = restore
        result = await self.apply.applyChangeSet(self.item['id'])
        self.assertFalse(result['success'])
        self.assertTrue(result['results'][0]['success'])
        self.assertEqual((await self.store.get(self.item['id']))['files'][0]['status'], 'applying')

    async def setup_host(self, host):
        self.store = Store()
        self.ref = ProjectRef('vscode-review' if host == 'vscode' else 'p', host)
        self.recorder = ChangeRecorder(self.store, 's', 'round', edit_mode='review')
        if host == 'preview':
            self.workspace = PreviewProjectWorkspace('p', 'react', {'/a.ts': 'old', '/b.ts': 'old-b'}, 1)
            self.provider = PreviewProjectProvider(PreviewProjectService(self.workspace))
        else:
            self.bridge = Bridge()
            self.provider = VSCodeProjectProvider(self.bridge)
        async def factory(ref, record): return self.provider
        self.apply = ApplyService(self.store, factory)
        self.undo = UndoService(self.store, factory)
    async def pending(self, updates):
        before = await self.provider.inspect_files(self.ref, list(updates))
        after = {p: snapshot(text, before[p]['version']) for p, text in updates.items()}
        self.item = await self.recorder.record(self.ref, before, after, {p: 'pending' for p in before})
        await self.recorder.seal()
    async def test_single_batch_repeat_and_undo_both_hosts(self):
        for host in ['preview', 'vscode']:
            with self.subTest(host=host):
                await self.setup_host(host)
                await self.pending({'/a.ts': 'new', '/b.ts': 'new-b'})
                initial = await self.provider.inspect_files(self.ref, ['/a.ts'])
                self.assertEqual(initial['/a.ts']['content'], 'old')
                first = self.item['files'][0]
                result = await self.apply.applyFile(self.item['id'], first['id'])
                self.assertTrue(result['success'])
                self.assertTrue((await self.apply.applyFile(self.item['id'], first['id']))['unchanged'])
                self.assertTrue((await self.apply.applyChangeSet(self.item['id']))['success'])
                self.assertTrue((await self.undo.undoChangeSet(self.item['id']))['success'])
                current = await self.provider.inspect_files(self.ref, ['/a.ts', '/b.ts'])
                self.assertEqual(current['/a.ts']['content'], 'old')
                self.assertEqual(current['/b.ts']['content'], 'old-b')
                record = await self.store.get(self.item['id'])
                self.assertTrue(all(f['status'] == 'reverted' for f in record['files']))
    async def test_create_delete_confirm_and_restore_both_hosts(self):
        for host in ['preview', 'vscode']:
            await self.setup_host(host)
            await self.pending({'/a.ts': None, '/created.ts': 'created'})
            self.assertTrue((await self.apply.applyChangeSet(self.item['id']))['success'])
            current = await self.provider.inspect_files(self.ref, ['/a.ts', '/created.ts'])
            self.assertIsNone(current['/a.ts']['content'])
            self.assertEqual(current['/created.ts']['content'], 'created')
            self.assertTrue((await self.undo.undoChangeSet(self.item['id']))['success'])
            current = await self.provider.inspect_files(self.ref, ['/a.ts', '/created.ts'])
            self.assertEqual(current['/a.ts']['content'], 'old')
            self.assertIsNone(current['/created.ts']['content'])
    async def test_conflict_blocks_batch_without_false_applied(self):
        for host in ['preview', 'vscode']:
            await self.setup_host(host)
            await self.pending({'/a.ts': 'new', '/b.ts': 'new-b'})
            if host == 'preview': self.workspace.revision += 1
            else: self.bridge.files['/a.ts']['dirty'] = True
            result = await self.apply.applyChangeSet(self.item['id'])
            self.assertFalse(result['success'])
            self.assertEqual((await self.provider.inspect_files(self.ref, ['/b.ts']))['/b.ts']['content'], 'old-b')
            self.assertTrue(all(f['status'] == 'pending' for f in (await self.store.get(self.item['id']))['files']))
    async def test_vscode_staging_multiple_edits_reads_candidates_not_disk(self):
        await self.setup_host('vscode')
        token = current_recorder.set(self.recorder)
        try:
            first = await self.provider.write_file(self.ref, '/a.ts', 'candidate', 1)
            second = await self.provider.patch_file(self.ref, '/a.ts', 'candidate', 'final', 1)
            self.assertTrue(first['pending'] and second['pending'])
            self.assertEqual(self.bridge.files['/a.ts']['content'], 'old')
            self.assertEqual((await self.provider.read_file(self.ref, '/a.ts'))['content'], 'final')
            item = next(iter(self.recorder.sets.values()))
            self.assertEqual(len(item['files']), 1)
            self.assertEqual(item['files'][0]['before']['content'], 'old')
            self.assertEqual(item['files'][0]['after']['content'], 'final')
            self.assertTrue(all(call == 'project.inspectFiles' for call in self.bridge.calls))
        finally: current_recorder.reset(token)
    async def test_partial_save_failure_keeps_truthful_results_and_blocks_blind_replay(self):
        await self.setup_host('vscode')
        await self.pending({'/a.ts': 'new', '/b.ts': 'new-b'})
        self.bridge.fail = '/b.ts'
        result = await self.apply.applyChangeSet(self.item['id'])
        self.assertFalse(result['success'])
        statuses = {f['path']: f['status'] for f in (await self.store.get(self.item['id']))['files']}
        self.assertEqual(statuses, {'/a.ts': 'applied', '/b.ts': 'failed'})
        self.assertEqual(self.bridge.files['/a.ts']['content'], 'new')
        self.assertEqual(self.bridge.files['/b.ts']['content'], 'old-b')
        with self.assertRaises(ProjectAPIError): await self.apply.applyChangeSet(self.item['id'])
    async def test_unsealed_and_unknown_file_cannot_apply(self):
        await self.setup_host('preview')
        await self.pending({'/a.ts': 'new'})
        item = await self.store.get(self.item['id'])
        item['sealed'] = False
        await self.store.put(item)
        with self.assertRaises(ProjectAPIError): await self.apply.applyChangeSet(item['id'])
        item['sealed'] = True
        await self.store.put(item)
        with self.assertRaises(ProjectAPIError): await self.apply.applyFile(item['id'], 'other')

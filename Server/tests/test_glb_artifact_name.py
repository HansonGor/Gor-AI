import asyncio
from io import BytesIO
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import UploadFile
from routes import chat_routes


@pytest.mark.parametrize('filename', ['机器人.glb', '机器人.GLB', '机器人.glb.glb', '机器人.GLB.glb'])
def test_glb_upload_saves_one_suffix_in_response_and_persisted_metadata(tmp_path, filename):
    persist = AsyncMock()
    with (
        patch.object(chat_routes, 'session_exists', new=AsyncMock(return_value=True)),
        patch.object(chat_routes, 'GENERATED_ROOT', tmp_path),
        patch.object(chat_routes, 'ensure_storage_dirs', side_effect=AssertionError('virtual exports must not create directories')),
        patch.object(chat_routes, 'validate_glb_stream'),
        patch.object(chat_routes, 'save_session_generated_artifact', new=persist),
    ):
        result = asyncio.run(chat_routes.save_generated_glb(
            'test-session', UploadFile(filename=filename, file=BytesIO(b'validated-separately')), 'reply-id',
        ))
    assert result['file']['displayName'] == '机器人.glb'
    assert persist.await_args.args[2] == '机器人.glb'
    assert persist.await_args.args[6]['displayName'] == '机器人.glb'
    assert persist.await_args.kwargs['message_id'] == 'reply-id'
    assert persist.await_args.args[3] is None
    assert persist.await_args.kwargs['artifact_bytes'] == b'validated-separately'
    assert list(tmp_path.iterdir()) == []

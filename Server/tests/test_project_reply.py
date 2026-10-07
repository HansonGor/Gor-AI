from agent.project_reply import project_subject, summarize_project_changes


def test_completion_explains_content_and_web_viewing_without_source():
    text = summarize_project_changes('生成一个 React 待办清单', ['/src/App.jsx', '/src/App.jsx', '/index.html'])
    assert 'React 项目' in text
    assert '内容是待办清单' in text
    assert '2 个文件' in text
    assert '预览项目' in text and 'Diff' in text
    assert '/src/' not in text and '<h1>' not in text


def test_plugin_guidance_never_promises_preview_worker():
    text = summarize_project_changes('将标题改回来', ['/src/App.jsx'], provider='vscode')
    assert '恢复为之前的版本' in text
    assert 'VS Code 工作区' in text and 'Diff' in text
    assert '预览' not in text


def test_3d_completion_names_confirmed_model_and_guides_glb_download():
    files = {'/src/scene.json': '{"name":"简单机器人"}', '/index.html': '<title>New React Project</title>'}
    text = summarize_project_changes('生成3D模型', ['/src/scene.json'], scene=True, subject=project_subject(files))
    assert '简单机器人' in text and 'GLB' in text and '预览模型' in text
    assert '/src/scene.json' not in text


def test_subject_uses_titles_not_generic_templates_or_source():
    assert project_subject({'/index.html': '<title>天气展示</title>'}) == '天气展示'
    assert project_subject({'/index.html': '<title>New React Project</title>'}) == ''
    assert project_subject({'/src/scene.json': 'invalid'}) == ''
    assert '没有产生新的变更' in summarize_project_changes('改标题', [])

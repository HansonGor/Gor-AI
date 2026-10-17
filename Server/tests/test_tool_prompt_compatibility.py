"""Explicitly revised skill cards change; unrelated literal instruction cards stay fixed."""

import hashlib

import agent.tool_routing as routing


def test_unrelated_instruction_cards_remain_unchanged():
    expected = {
        "BASE_PROMPT": "3f470b18b263868de5af9ac94e614e1e50300068cc2d9c500417bd4f68e4160f",
        "PROJECT_BASE_PROMPT": "8d2722380453fbce4dc34be78467e286c712c03f6d9b87828f51348a4fd2033e",
        "WEB_PROMPT": "67ea77a0f7eda6ca370144f1762ae853c62fbac064c45add7c01a20e4acab756",
        "WEB_FALLBACK_PROMPT": "45ab0fa929dba2c4008fdac1a3ebf34ff0de1df43671a8d67188d07a59f20a4b",
        "NEWS_RESEARCH_PROMPT": "0067d02de0499978179e078cedde1b7974c00f119e380fc3b92cfd279efee611",
        "WEB_READER_PROMPT": "0a31aada7b8079927e64a380e735d2ac36fce8ed021b3b02dbcc3d43de228069",
        "GITHUB_CODE_PROMPT": "52930b5fa0c1085dbe92d1427d11f6e6e919db8ce60b6cc9b3974c0d52fc5be3",
        "WEATHER_PROMPT": "e80d00bcb9fa3888ae4c84ff60be4346aab44c22f786f065dce8f0cefbe0caa5",
        "IMAGE_PROMPT": "0cebb95d74460e00326727487896ac27b0442a5b244fed24232ec48689b8273b",
        "DOCUMENT_PROMPT": "325c6b0c38e554fc7d32a4fe4869cc8dcc4d0254fa0eea54843029390495fdad",
        "PREVIEW_PROMPT": "c9eba225c9a632479cdc04b02dca701f3c901b7b0245498146db9bc07d3aea0a",
        "PREVIEW_3D_PROMPT": "2285bd9963de5b921d5309c318323f4034c6f194d7c9e1cd302886b9a3f9355d",
        "PREVIEW_GLB_EXPORT_PROMPT": "ab1c203afc76d8b968faaa4921c0e82403df34969be79467286814efe7f0b1b7",
        "PROJECT_PROMPT": "e7534451b3bbb16d7b71ec7f626cfe0d37bcf56a45a2e813567213c0e60f2595",
        "VSCODE_PROJECT_READ_PROMPT": "d2f5dfdb8a455e91583854f0d2de0dcbfb283ab775d920e0a98116027839fffb",
        "VSCODE_PROJECT_EDIT_PROMPT": "9994969bbf82d38ff749d8b292a66d460b71f5d5850553ac97309e0d54fda36c",
        "VSCODE_ACCESS_CHECK_PROMPT": "fc5878de074b1665e09351544770afd345aee14d753ac45c970b0b4360067e02",
        "VSCODE_UNREGISTERED_PROMPT": "678075f3898caa2713a98400cd47cfde5224e92aee6bf87893f1e64b31daba5b",
        "PYTHON_PROMPT": "16613c7db289ddd3d50ba760a499c111a3f2d1cd9f9d2b1e432a3f5a476efb52",
        "KNOWLEDGE_PROMPT": "9c16346952e40da57b2fb1f108901a46a5c90e342973f5a9e8e34bf7e0753d26",
        # 2026-10-15 新增、2026-10-16 按用户要求扩展（启动项目 / 安装依赖 / 两种模式分级 / Git / 删除项目 / 项目外只读 / 提交默认推送）：VS Code 工具链施行规则卡
        "TOOLCHAIN_PROMPT": "67f11f0e91cb1100825daa1de55cc5a1fb303e2c7c55a9fd514aad59e8edd001",
        "VIDEO_PROMPT": "1c4d41ae8f02b6e109120c37e7135c3e7b419821b346261678a625cfe79e9261",
    }
    for name, checksum in expected.items():
        assert hashlib.sha256(getattr(routing, name).encode()).hexdigest() == checksum, name

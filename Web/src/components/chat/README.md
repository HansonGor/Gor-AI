# Shared Chat UI

`src/components/chat` is the stable import surface for chat UI shared by the web app and the VS Code webview. Import only the components a host needs, plus the shared skin when using page-level chat layout components:

```tsx
import '../../components/chat/styles.less';
import { ChatBox, ChatHeader, ChatPageLayout, ChatSidebarLayer } from '../../components/chat';
```

`ChatBox`, `MessageList`, `MessageBubble`, and `InputArea` are conversation primitives. `ProjectChanges` is the shared, source-only-in-Diff presentation for both providers, with changes/title supplied through props and no I/O. `ChatHeader`, `ChatSidebarLayer`, and `ChatPageLayout` compose the responsive page shell. Hosts own session state, navigation, and runtime-specific capabilities, and pass those through props; plugin-only behavior should not be embedded in the visual primitives.

`styles.less` is the shared skin entry. It currently reuses the existing chat page stylesheet so existing Web and VS Code layouts stay visually identical while styles are migrated into component-level files incrementally.

## Runtime rules (2026-10-07)

- Public chat components, concise change summaries and Diff display are shared by both hosts.
- The Web entry explicitly declares `clientMode: web`. Project CRUD targets the current browser project only; new generation requests create independent projects. Source and deliverables open in Preview Worker automatically.
- The VS Code entry declares `clientMode: vscode` and its live workspace ID. Project CRUD targets that workspace through VS Code Project API. It must never bootstrap a Web project, invoke Preview tools or mount Preview Worker.
- A new Web project is staged off-screen. Keep the old preview unchanged until generation completes, full source is synchronized and any GLB virtual bytes are saved; only then publish the new project and auto-open Preview Worker. Failure or cancellation never replaces the old preview. Actual errors after publication remain visible.
- Chat replies explain successful actions in plain language. Source and line-by-line changes belong in Diff, not in chat prose. `Server/agent/project_reply.py` owns this shared completion behavior.
- Preview Worker orders all project/artifact entries by first creation in the conversation (oldest first, newest last). Edits do not move an existing project. Code and source downloads resolve only the selected target's identity; a previously selected generated artifact must never supply another project's source.
- Web automatic GLB export uses the Web-only `api/webProjectArtifacts.ts` adapter and raw binary PUT, persisted as database BYTEA with no server filesystem output. The adapter rejects plugin mode. Explicit user downloads may save locally; browser caches and databases consume storage even though project files are virtual. Legacy disk-backed artifacts remain readable. See root `project.md` and `AGENTS.md` before changing storage or host behavior.

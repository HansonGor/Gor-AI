/** Development-only acceptance harness. Not an application route or production entry. */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PresentationPreview from '../src/components/preview/PresentationPreview';
import PreviewWorker from '../src/components/ChatBox/PreviewWorker';
import { createPresentationSnapshot } from '../src/preview/core/presentationSnapshot';
import { createReactTemplate } from '../src/preview/templates/reactTemplate';
import { createSceneProjectFiles } from '../src/modeling/sceneSpec';
import type { GeneratedFile, PreviewProjectSnapshot } from '../src/types';

function Harness() {
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [worker, setWorker] = useState(false);
  const [open, setOpen] = useState(true);
  const [hidden, setHidden] = useState<string[]>([]);
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [target, setTarget] = useState<'project-snapshot' | 'generated'>('project-snapshot');
  useEffect(() => {
    const name = new URLSearchParams(location.search).get('manifest');
    if (!name?.match(/^motion-acceptance-[a-f0-9-]+\.json$/)) {
      setError('先运行 Server/tests/generate_motion_acceptance.py，再使用输出链接。');
      return;
    }
    fetch(`/api/download/${encodeURIComponent(name)}`)
      .then((response) => {
        if (!response.ok) throw Error(String(response.status));
        return response.json();
      })
      .then(setFiles)
      .catch((error) => setError(String(error)));
  }, []);
  const artifact = files[active];
  const snapshots: PreviewProjectSnapshot[] = files.flatMap((file, index) => {
    const snapshot = createPresentationSnapshot(file, `ppt-${index}`);
    return snapshot ? [snapshot] : [];
  });
  const reactFiles = createReactTemplate();
  reactFiles['/src/App.tsx'] =
    'export default function App() { return <h1>React isolation fixture</h1>; }';
  const react: PreviewProjectSnapshot = {
    id: 'react-smoke',
    messageId: 'react-smoke',
    name: 'React 隔离测试',
    template: 'react',
    outputExtension: '.html',
    files: reactFiles,
  };
  const scene = {
    version: 1 as const,
    name: 'Three 隔离测试',
    objects: [
      {
        id: 'test-cube',
        name: 'Test cube',
        geometry: 'box' as const,
        size: [1, 1, 1] as [number, number, number],
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        color: '#aa3344',
        metalness: 0.2,
        roughness: 0.7,
        copy_offsets: [],
      },
    ],
  };
  const three: PreviewProjectSnapshot = {
    id: 'three-smoke',
    messageId: 'three-smoke',
    name: scene.name,
    template: 'html',
    outputExtension: '.glb',
    files: createSceneProjectFiles(scene),
  };
  const allSnapshots = [...snapshots, react, three];
  const [selectedMessage, setSelectedMessage] = useState('ppt-0');
  const selected =
    allSnapshots.find((snapshot) => snapshot.messageId === selectedMessage) ?? allSnapshots[0];
  const selectSnapshot = (
    snapshot: PreviewProjectSnapshot,
    intent: 'preview' | 'source' = 'preview',
  ) => {
    setSelectedMessage(snapshot.messageId);
    setHidden((keys) => keys.filter((key) => key !== `project-snapshot:${snapshot.messageId}`));
    setTarget('project-snapshot');
    setMode(intent === 'source' ? 'code' : 'preview');
    setOpen(true);
  };
  return (
    <>
      <nav
        style={{ height: 46, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px' }}
      >
        {files.map((file, index) => (
          <button
            key={file.artifactId}
            onClick={() => {
              setActive(index);
              if (snapshots[index]) selectSnapshot(snapshots[index]);
            }}
          >
            {index === 0 ? '发布会 A' : index === 1 ? '咨询报告 B' : '发布会 A 点击版'}
          </button>
        ))}
        <button onClick={() => setWorker((value) => !value)}>
          {worker ? '单页模式' : '完整 Worker'}
        </button>
        {worker && (
          <>
            <button onClick={() => selectSnapshot(react)}>React</button>
            <button onClick={() => selectSnapshot(three)}>Three</button>
            <button
              onClick={() => {
                setHidden([]);
                setOpen(true);
              }}
            >
              恢复列表
            </button>
          </>
        )}
        <span>{error || artifact?.snapshotId}</span>
      </nav>
      <main style={{ height: 'calc(100vh - 46px)' }}>
        {worker && selected && open ? (
          <PreviewWorker
            files={[]}
            messagePreviewArtifacts={allSnapshots.map((snapshot) => ({
              messageId: snapshot.messageId,
              snapshot,
              files: snapshot.finalArtifact ? [snapshot.finalArtifact] : [],
            }))}
            activeFile={null}
            projectSourcePaths={[]}
            uploadedAttachments={[]}
            activeUploadedAttachmentKey={null}
            onSelectUploadedAttachment={() => {}}
            onOpenUploadedAttachment={() => {}}
            hiddenArtifactKeys={hidden}
            onDeleteArtifact={(keys) =>
              setHidden((previous) => [...new Set([...previous, ...keys])])
            }
            hasProjectSource={false}
            mode={mode}
            target={target}
            projectSnapshots={allSnapshots}
            activeProjectSnapshot={selected}
            onSelectProjectSnapshot={selectSnapshot}
            onModeChange={setMode}
            onTargetChange={(value) => setTarget(value as 'project-snapshot' | 'generated')}
            onClose={() => setOpen(false)}
          />
        ) : worker ? (
          <div role="status">列表已清空。点“恢复列表”或上方项目按钮重新打开。</div>
        ) : (
          artifact?.presentationSchema && (
            <PresentationPreview
              key={artifact.snapshotId}
              schema={artifact.presentationSchema}
              backgrounds={artifact.presentationBackgrounds}
              renderedSlides={artifact.renderedSlides}
            />
          )
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);

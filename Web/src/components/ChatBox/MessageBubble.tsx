import { isToolStatusInThinking } from '../../utils/thinking';
import { useShowThinking } from '../../utils/thinkingVisibility';
﻿// 单条消息气泡
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Box,
  ChevronRight,
  Code2,
  Eye,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Globe2,
  LoaderCircle,
  Sparkles,
  Paperclip,
  Presentation,
  Folder,
  ChevronDown,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownCodeComponents } from '../chat/MarkdownCodeBlock';
import { MODEL_CONFIG, LAYOUT_CONFIG } from '../../config';
import { previewArtifactName, previewSnapshotExtension } from '../../preview/core/artifactFormat';
import { isPreviewableGeneratedFile } from '../../preview/core/previewFilePresence';
import { extractVideoUrl, removeVideoUrl, buildProxyVideoUrl } from '../../utils/video';
import type { MessageBubbleProps, SearchSource } from '../../types';
import { Button } from '../ui/button';
import ProjectChanges from '../chat/ProjectChanges';
import ThinkingPanel from '../chat/ThinkingPanel';
import ToolchainRunCard from '../chat/ToolchainRunCard';
import { ToolchainRunsContext } from '../chat/toolchainRun';
import { createProjectChangeClient } from '../../api/projectChanges';
import { createWebProjectChangeClient } from '../../api/webProjectChanges';
import { getChatClientMode } from '../../utils/clientMode';
import { useFeedback } from '../ui/feedback';

const QUOTA_WARNING_THRESHOLD = MODEL_CONFIG.QUOTA_WARNING_THRESHOLD;

function GeneratedFileIcon({ type }: { type: string }) {
  if (type === 'word' || type === 'pdf') return <FileText aria-hidden="true" />;
  if (type === 'excel') return <FileSpreadsheet aria-hidden="true" />;
  if (type === 'ppt') return <Presentation aria-hidden="true" />;
  if (type === '3d') return <Box aria-hidden="true" />;
  if (['html', 'react', 'vue'].includes(type)) return <Globe2 aria-hidden="true" />;
  return <Paperclip aria-hidden="true" />;
}

function formatMessageTime(message: { created_at?: string; id: string }): string {
  let ts: number | null = null;
  if (message.created_at) {
    const t = new Date(message.created_at).getTime();
    if (!Number.isNaN(t)) ts = t;
  } else if (/^\d{10,}$/.test(message.id)) {
    ts = Number(message.id);
  }
  if (ts === null) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 联网来源折叠块：只展示后端真实搜索结果（禁止 LLM 编造来源）
function SourceFavicon({ source }: { source: SearchSource }) {
  const [failed, setFailed] = useState(false);
  let faviconUrl = '';
  try {
    const sourceUrl = new URL(source.url);
    if (sourceUrl.protocol === 'http:' || sourceUrl.protocol === 'https:') {
      faviconUrl = `${sourceUrl.origin}/favicon.ico`;
    }
  } catch {
    faviconUrl = '';
  }

  return (
    <span className="search-source-favicon" aria-hidden="true">
      {faviconUrl && !failed
        ? <img src={faviconUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <Globe2 />}
    </span>
  );
}

function getSourceSiteName(source: SearchSource, hostname: string): string {
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, '');
  const knownSites: Array<[RegExp, string]> = [
    [/^(?:[\w-]+\.)?gz\.gov\.cn$/, '广州市人民政府'],
    [/^(?:[\w-]+\.)?huadu\.gov\.cn$/, '花都区政府'],
    [/^(?:[\w-]+\.)?southcn\.com$/, '南方网'],
    [/^(?:[\w-]+\.)?gzdaily\.cn$/, '广州日报'],
    [/(?:^|\.)cctv\.com$/, '央视新闻'],
    [/(?:^|\.)(?:news\.cn|xinhuanet\.com)$/, '新华网'],
  ];
  const known = knownSites.find(([pattern]) => pattern.test(normalizedHost));
  if (known) return known[1];

  const providerNames = new Set(['tavily', 'serper', 'doubao', 'brave', 'github', 'pexels', 'pixabay', 'unsplash']);
  if (source.source && !providerNames.has(source.source.toLowerCase())) return source.source;
  return source.title || normalizedHost || '网页来源';
}

function SearchSourcesBlock({ sources }: { sources: SearchSource[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const sourceCount = sources?.length ?? 0;

  const updateScrollAffordance = () => {
    const list = listRef.current;
    setCanScrollRight(Boolean(list && list.scrollWidth - list.clientWidth - list.scrollLeft > 4));
  };

  useEffect(() => {
    updateScrollAffordance();
    window.addEventListener('resize', updateScrollAffordance);
    return () => window.removeEventListener('resize', updateScrollAffordance);
  }, [sourceCount, expanded]);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="search-sources">
      <button
        type="button"
        className="search-sources-heading"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`参考来源，共 ${sources.length} 条，${expanded ? '收起' : '展开'}`}
      >
        <span>参考来源</span>
        <span className="search-sources-count">{sources.length}</span>
        <ChevronDown className={`search-sources-disclosure ${expanded ? 'is-expanded' : ''}`} aria-hidden="true" />
      </button>
      {expanded && <div className="search-sources-track-wrap">
        <ul className="search-sources-track" ref={listRef} onScroll={updateScrollAffordance} aria-label="参考来源列表">
          {sources.map((src, index) => {
            let hostname = src.domain || '';
            try { hostname = new URL(src.url).hostname || hostname; } catch { /* use backend domain */ }
            const siteName = getSourceSiteName(src, hostname);
            const domain = (src.domain || hostname).replace(/^www\./i, '');
            return (
              <li key={`${src.url}-${index}`} className="search-source-card-item">
                <a href={src.url} target="_blank" rel="noreferrer" className="search-source-card" title={src.title || src.url}>
                  <SourceFavicon source={src} />
                  <span className="search-source-card-copy">
                    <strong>{siteName}</strong>
                    <small>{domain || '打开来源网页'}</small>
                  </span>
                  <ExternalLink className="search-source-card-external" aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
        {canScrollRight && (
          <button
            type="button"
            className="search-sources-scroll-button"
            aria-label="向右查看更多来源"
            onClick={() => listRef.current?.scrollBy({ left: 220, behavior: 'smooth' })}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </div>}
    </div>
  );
}

export default function MessageBubble({
  message,
  currentPreviewProject,
  uploadedAttachments: replyAttachments = [],
  onPreviewFile,
  onPreviewProject,
  onPreviewAttachment,
}: MessageBubbleProps) {
  const { notify } = useFeedback();
  const projectChangeClient = useMemo(() => {
    const target = message.projectChangeSet;
    if (!target || !target.sessionId
      || (target.provider === 'preview' ? 'web' : 'vscode') !== getChatClientMode()) return undefined;
    return target.provider === 'preview'
      ? createWebProjectChangeClient(target.sessionId)
      : createProjectChangeClient(target.sessionId, { mode: 'vscode' });
  }, [message.projectChangeSet?.id, message.projectChangeSet?.provider, message.projectChangeSet?.sessionId]);
  // Responsive policy stays outside the pure Diff: narrow Web and Webview
  // both use Unified only, including after resizing from desktop Split.
  const [allowDiffSplit, setAllowDiffSplit] = useState(() => typeof window === 'undefined'
    || window.innerWidth >= LAYOUT_CONFIG.PC_BREAKPOINT);
  useEffect(() => {
    const update = () => setAllowDiffSplit(window.innerWidth >= LAYOUT_CONFIG.PC_BREAKPOINT);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const logoGradientId = useId().replace(/:/g, '');
  const isUser = message.role === 'user';
  // 施行卡片只在宿主注入能力时出现（插件端）；Web 端没有 Provider，不渲染。
  const toolchain = useContext(ToolchainRunsContext);
  const toolchainRuns = !isUser && toolchain ? toolchain.runsFor(message) : [];
  const codeComponents = useMemo(() => markdownCodeComponents({ streaming: message.isStreaming }), [message.isStreaming]);
  const images = message.images ?? [];
  const hasImages = isUser && images.length > 0;
  const messageTime = formatMessageTime(message);

  const contentVideoUrl = extractVideoUrl(message.content);
  const finalVideoUrl = message.videoUrl || contentVideoUrl;
  const displayContent =
    contentVideoUrl && !message.videoUrl
      ? removeVideoUrl(message.content, contentVideoUrl)
      : message.content;
  const proxyVideoUrl = buildProxyVideoUrl(finalVideoUrl);
  const generatedFiles = message.files?.length ? message.files : message.file ? [message.file] : [];
  const sceneArtifact = generatedFiles.find((file) => file.fileType === '3d');
  const previewableGeneratedFiles = generatedFiles.filter((file) =>
    isPreviewableGeneratedFile(file) && (file.fileType !== '3d' || Boolean(message.previewSnapshot)),
  );
  const hasProjectOutput = (message.previewChanges?.length ?? 0) > 0 || Boolean(message.previewSnapshot && message.projectChanges?.length);
  const isPresentationSnapshot = message.previewSnapshot?.template === 'presentation';
  const hasRestorableProjectOutput = Boolean(message.previewSnapshot && (hasProjectOutput || isPresentationSnapshot));
  const snapshotArtifactSummary = hasRestorableProjectOutput && message.previewSnapshot
    ? {
        name: previewArtifactName(message.previewSnapshot, previewSnapshotExtension(message.previewSnapshot)),
        title: previewArtifactName(message.previewSnapshot, previewSnapshotExtension(message.previewSnapshot))
          .replace(/\.[^.]+$/, ''),
        extension: previewSnapshotExtension(message.previewSnapshot),
        kind: previewSnapshotExtension(message.previewSnapshot) === '.glb' ? '3D 模型' : isPresentationSnapshot ? '演示文稿' : '网页项目',
    }
    : null;
  const currentPreviewProjectIsRelevant = Boolean(currentPreviewProject && (
    message.previewChanges?.some((change) => change.projectId === currentPreviewProject.id)
    || (!message.previewChanges?.length && !message.previewSnapshot && (message.tokenUsage?.preview_tool_calls ?? 0) > 0)
  ));
  const currentPreviewExtension = currentPreviewProject?.outputExtension ?? '.html';
  const currentPreviewProjectSummary = currentPreviewProjectIsRelevant && currentPreviewProject
    ? {
        name: /\.[a-z0-9]+$/i.test(currentPreviewProject.name)
          ? currentPreviewProject.name
          : `${currentPreviewProject.name}${currentPreviewExtension}`,
        title: currentPreviewProject.name.replace(/\.[^.]+$/, ''),
        extension: currentPreviewExtension,
        kind: currentPreviewExtension === '.glb'
          ? '3D 模型'
          : currentPreviewExtension === '.pptx' || currentPreviewProject.template === 'presentation'
            ? '演示文稿'
            : '网页项目',
      }
    : null;
  const projectArtifactSummary = snapshotArtifactSummary ?? currentPreviewProjectSummary;
  const changedSourcePaths = message.previewChanges?.map((change) => change.path) ?? [];
  const preferredSourcePath =
    (isPresentationSnapshot && message.previewSnapshot?.files['/presentation.json'] ? '/presentation.json' : undefined) ??
    changedSourcePaths.find((path) => /\/src\/App\.[jt]sx?$/i.test(path)) ??
    changedSourcePaths.find((path) => /\.[jt]sx?$/i.test(path)) ??
    changedSourcePaths[0];
  const uploadedAttachments = isUser ? message.attachments ?? [] : [];
  const attachmentOnlyLabel = uploadedAttachments.length
    ? `已发送：${uploadedAttachments.map((attachment) => attachment.name).join('、')}`
    : '';
  const visibleUserContent = message.content === attachmentOnlyLabel ? '' : displayContent;
  const showExecutionTimeline = !isUser && Boolean(message.isStreaming && message.executionPhase);
  // “显示思考过程”关闭时只隐藏卡片；思考记录照常接收与保存，重新打开即可看到
  const showThinking = useShowThinking();
  const hasThinking = !isUser && showThinking && Boolean(message.thinkingTrace?.rounds.length);

  return (
    <div
      className={`message-row flex max-w-full flex-col items-start ${isUser ? 'row-user items-end' : 'row-assistant'} ${showExecutionTimeline ? 'row-streaming' : ''}`}
    >
      <div
        className={`message-bubble relative break-words rounded-[0.3rem] px-[0.24rem] py-[0.18rem] text-[0.28rem] leading-[1.6] lg:rounded-xl lg:px-5 lg:py-4 lg:text-[14px] lg:leading-[1.55] ${
          isUser
            ? 'bubble-user max-w-[80%] border border-white/20 bg-gradient-to-br from-[#667eea] to-[#8b5cf6] text-white shadow-lg shadow-purple-500/25 lg:max-w-[58%]'
            : `bubble-assistant max-w-[88%] border border-white/[0.08] bg-white/[0.06] text-[#f5f5f7] shadow-sm lg:w-full lg:max-w-[860px] ${showExecutionTimeline ? 'bubble-assistant-streaming' : ''}`
        }`}
      >
        {!isUser && (
          <div className="assistant-stream-brand">
            <span className="assistant-stream-brand-mark">
              <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
                <defs>
                  <radialGradient id={logoGradientId} cx="50%" cy="50%" r="55%">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="42%" stopColor="#ecddff" />
                    <stop offset="78%" stopColor="#b78cff" />
                    <stop offset="100%" stopColor="#8b5cf6" />
                  </radialGradient>
                </defs>
                <path
                  d="M16 0.8 C17.9 9.2 24.6 14.6 31.2 16 C24.6 17.4 17.9 22.8 16 31.2 C14.1 22.8 7.4 17.4 0.8 16 C7.4 14.6 14.1 9.2 16 0.8 Z"
                  fill={`url(#${logoGradientId})`}
                />
              </svg>
            </span>
            <strong>Gor</strong>
          </div>
        )}

        {hasImages && (
          <div className="message-images">
            {images.map((img, idx) => (
              <img key={idx} src={img} alt="上传图片" className="message-image" />
            ))}
          </div>
        )}

        {uploadedAttachments.length > 0 && (
          <div className="uploaded-attachments" aria-label="随消息发送的文件">
            {uploadedAttachments.map((attachment, index) => {
              const AttachmentIcon = attachment.kind === 'folder' ? Folder : Paperclip;
              return (
                <a
                  className="uploaded-attachment-chip"
                  key={`${attachment.storageId ?? attachment.name}-${index}`}
                  title={attachment.name}
                  href={attachment.downloadUrl}
                  download={attachment.downloadUrl && attachment.kind !== 'folder' ? attachment.name : undefined}
                  onClick={(event) => { if (!attachment.downloadUrl) event.preventDefault(); }}
                >
                  <AttachmentIcon aria-hidden="true" />
                  <span>{attachment.name}</span>
                </a>
              );
            })}
          </div>
        )}

        {hasThinking && message.thinkingTrace && <ThinkingPanel trace={message.thinkingTrace} />}

        {toolchain && toolchainRuns.map((run) => (
          <ToolchainRunCard key={run.runId} run={run}
            onShown={() => toolchain.onShown(run)} onApprove={(options) => toolchain.onApprove(run, options)}
            onApplyAndRun={() => toolchain.onApplyAndRun(run)}
            onSkip={() => toolchain.onSkip(run)} onStopRound={() => toolchain.onStopRound(run)}
            onAbort={() => toolchain.onAbort(run)} onOpenUrl={() => toolchain.onOpenUrl(run)} />
        ))}

        {showExecutionTimeline && !displayContent && (
          <div className="assistant-loading-indicator" role="status" aria-label="正在生成回答">
            <span className="assistant-loading-visual" aria-hidden="true">
              <span className="assistant-loading-glow" />
              <span className="assistant-loading-orbit">
                <span className="assistant-loading-orbit-dot" />
              </span>
              <span className="assistant-loading-core"><Sparkles /></span>
            </span>
            <span className="assistant-loading-label">正在整理内容</span>
          </div>
        )}

        {(isUser ? visibleUserContent : displayContent) &&
          (isUser ? visibleUserContent : displayContent) !== '（图片）' &&
          (isUser ? (
            <span className="message-content whitespace-pre-wrap">{visibleUserContent}</span>
          ) : (
            <div className="message-content markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={codeComponents}>{displayContent}</ReactMarkdown>
            </div>
          ))}

        {!isUser && !message.isStreaming && message.projectChanges && message.projectChanges.length > 0 && (
          <ProjectChanges changes={message.projectChanges} label="本次代码修改" allowSplit={allowDiffSplit}
            title={`本次变更 ${message.projectChanges.length} 个文件`}
            changeSetId={message.projectChangeSet?.id} changeClient={projectChangeClient} onNotify={notify} />
        )}

        {!isUser && !message.isStreaming && message.previewChanges && message.previewChanges.length > 0 && (
          <ProjectChanges changes={message.previewChanges} label="虚拟项目文件" allowSplit={allowDiffSplit}
            restored={message.previewChangesRestored}
            changeSetId={message.projectChangeSet?.id} changeClient={projectChangeClient} onNotify={notify}
            title={message.previewChangesRestored
              ? `已恢复项目文件 ${message.previewChanges.length} 个`
              : `本轮更新了 ${message.previewChanges.length} 个项目文件`} />
        )}

        {!isUser && !message.isStreaming && (
          projectArtifactSummary || hasRestorableProjectOutput || hasProjectOutput || previewableGeneratedFiles.length > 0
        ) && (
          <>
            {projectArtifactSummary && (
              <div
                className="message-project-preview-summary"
                aria-label={`当前项目：${projectArtifactSummary.title}，${projectArtifactSummary.kind}`}
              >
                <span className="message-project-preview-icon">
                  {projectArtifactSummary.kind === '3D 模型'
                    ? <Box aria-hidden="true" />
                    : <Globe2 aria-hidden="true" />}
                </span>
                <span className="message-project-preview-copy">
                  <span className="message-project-preview-label">当前项目</span>
                  <strong className="message-project-preview-name" title={projectArtifactSummary.name}>
                    {projectArtifactSummary.title}
                  </strong>
                </span>
                <span className="message-project-preview-kind">
                  {projectArtifactSummary.kind}
                  <small>{projectArtifactSummary.extension.replace('.', '').toUpperCase()}</small>
                </span>
              </div>
            )}
            {(((hasRestorableProjectOutput || hasProjectOutput) && onPreviewProject)
              || (!hasRestorableProjectOutput && previewableGeneratedFiles.length > 0 && onPreviewFile)) && (
              <div
                className={`message-artifact-actions ${hasRestorableProjectOutput || hasProjectOutput ? 'message-project-actions' : ''}`}
                aria-label="预览和生成的产物"
              >
              {(hasRestorableProjectOutput || hasProjectOutput) && onPreviewProject && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="preview-project-open project-action-card"
                  onClick={() => onPreviewProject?.(sceneArtifact, 'preview', undefined, message.previewSnapshot)}
                >
                  <Eye aria-hidden="true" />
                  <span className="project-action-copy">
                    <span className="project-action-title">{sceneArtifact ? '预览模型' : isPresentationSnapshot ? '预览演示文稿' : '预览项目'}</span>
                    <span className="project-action-description">{'推窗见新景  笔墨生诗意'}</span>
                  </span>
                </Button>
              )}
              {(hasRestorableProjectOutput || hasProjectOutput) && onPreviewProject && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="preview-project-open project-action-card"
                  onClick={() => onPreviewProject?.(sceneArtifact, 'source', preferredSourcePath, message.previewSnapshot)}
                >
                  <Code2 aria-hidden="true" />
                  <span className="project-action-copy">
                    <span className="project-action-title">阅览源码</span>
                    <span className="project-action-description">{'展卷寻其源  墨韵见初心'}</span>
                  </span>
                </Button>
              )}
              {!hasRestorableProjectOutput && onPreviewFile && previewableGeneratedFiles.map((file) => (
                <Button
                  key={file.downloadUrl}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="preview-project-open"
                  onClick={() => onPreviewFile?.(file)}
                  title={file.displayName}
                >
                  <GeneratedFileIcon type={file.fileType} />
                  预览 {file.displayName}
                </Button>
              ))}
              </div>
            )}
          </>
        )}

        {!isUser && !message.isStreaming && replyAttachments.length > 0 && onPreviewAttachment && (
          <div className="uploaded-preview-actions" aria-label="上传附件预览">
            {replyAttachments.map((attachment, index) => (
              <Button
                key={`${attachment.kind ?? 'file'}:${attachment.name}:${index}`}
                type="button"
                variant="outline"
                size="sm"
                className="preview-project-open"
                onClick={() => onPreviewAttachment(attachment)}
              >
                在 Preview Worker 中预览{replyAttachments.length > 1 ? ` ${attachment.name}` : ''}
              </Button>
            ))}
          </div>
        )}

        {!isUser && !message.isStreaming && message.searchSources && message.searchSources.length > 0 && (
          <SearchSourcesBlock sources={message.searchSources} />
        )}

        {!isUser && message.tokenUsage && message.tokenUsage.total_tokens > 0 && (
          <div className="token-usage">
            <span className="token-icon">📊</span>
            <span
              className="token-text"
              title={(message.tokenUsage.calls || []).map((call) =>
                `#${call.index} ${call.reason}: Prompt ${call.prompt_tokens} / 输出 ${call.completion_tokens}`,
              ).join('\n')}
            >
              Token：累计 Prompt {message.tokenUsage.prompt_tokens.toLocaleString()}
              {message.tokenUsage.last_prompt_tokens !== undefined && `｜当前 Context ${message.tokenUsage.last_prompt_tokens.toLocaleString()}`}
              {message.tokenUsage.llm_call_count !== undefined && `｜LLM ${message.tokenUsage.llm_call_count} 次`}
              {`｜输出 ${message.tokenUsage.completion_tokens.toLocaleString()}｜合计 ${message.tokenUsage.total_tokens.toLocaleString()}`}
              {message.tokenUsage.preview_tool_calls !== undefined &&
                `｜Preview 工具 ${message.tokenUsage.preview_tool_calls} 次 / Patch ${message.tokenUsage.patch_operations || 0} 处`}
            </span>
          </div>
        )}

        {!isUser && message.modelQuotaInfo && (
          <div
            className={`model-quota-info ${message.modelQuotaInfo.new_remain <= QUOTA_WARNING_THRESHOLD ? 'warning' : ''}`}
          >
            <span className="quota-icon">
              {message.modelQuotaInfo.new_remain <= QUOTA_WARNING_THRESHOLD ? '⚠️' : '🔋'}
            </span>
            <span className="quota-text">
              {message.modelQuotaInfo.model_name}：剩余token：{message.modelQuotaInfo.new_remain}
            </span>
          </div>
        )}

        {proxyVideoUrl && (
          <div className="video-player-container">
            <video className="video-player" src={proxyVideoUrl} controls preload="auto" playsInline>
              您的浏览器不支持视频播放
            </video>
          </div>
        )}

        {!isUser && message.toolStatus && (!showThinking || !isToolStatusInThinking(message)) ? (
          <div className="tool-status">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{message.toolStatus}</span>
          </div>
        ) : (
          <>
            {message.isStreaming && !showExecutionTimeline && !displayContent && !finalVideoUrl && (
              <LoaderCircle
                className="h-4 w-4 animate-spin text-violet-300"
                aria-label="正在生成"
              />
            )}
          </>
        )}
      </div>

      {messageTime && (
        <span
          className={`message-time mt-[0.08rem] text-[0.2rem] leading-none text-white/35 ${isUser ? 'time-user text-right' : 'time-assistant text-left'}`}
        >
          {messageTime}
        </span>
      )}
    </div>
  );
}

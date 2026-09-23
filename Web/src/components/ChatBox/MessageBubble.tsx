// 单条消息气泡
import {
  Box,
  FileSpreadsheet,
  FileText,
  Globe2,
  LoaderCircle,
  Paperclip,
  Presentation,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MODEL_CONFIG } from '../../config';
import { extractVideoUrl, removeVideoUrl, buildProxyVideoUrl } from '../../utils/video';
import type { MessageBubbleProps } from '../../types';
import { Button } from '../ui/button';

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

export default function MessageBubble({
  message,
  onPreviewFile,
  onPreviewProject,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
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

  return (
    <div
      className={`message-row flex max-w-full flex-col items-start ${isUser ? 'row-user items-end' : 'row-assistant'}`}
    >
      <div
        className={`message-bubble relative break-words rounded-[0.3rem] px-[0.24rem] py-[0.18rem] text-[0.28rem] leading-[1.6] lg:rounded-xl lg:px-5 lg:py-4 lg:text-[14px] lg:leading-[1.55] ${
          isUser
            ? 'bubble-user max-w-[80%] border border-white/20 bg-gradient-to-br from-[#667eea] to-[#8b5cf6] text-white shadow-lg shadow-purple-500/25 lg:max-w-[58%]'
            : 'bubble-assistant max-w-[88%] border border-white/[0.08] bg-white/[0.06] text-[#f5f5f7] shadow-sm lg:w-full lg:max-w-[860px]'
        }`}
      >
        {hasImages && (
          <div className="message-images">
            {images.map((img, idx) => (
              <img key={idx} src={img} alt="上传图片" className="message-image" />
            ))}
          </div>
        )}

        {displayContent &&
          displayContent !== '（图片）' &&
          (isUser ? (
            <span className="message-content whitespace-pre-wrap">{displayContent}</span>
          ) : (
            <div className="message-content markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
            </div>
          ))}

        {!isUser && message.projectChanges && message.projectChanges.length > 0 && (
          <div className="project-changes" aria-label="本次代码修改">
            <div className="project-changes-title">
              已修改 {message.projectChanges.length} 个文件
            </div>
            {message.projectChanges.map((change, index) => (
              <details key={`${change.path}-${index}`} className="project-change">
                <summary>{change.path} · 查看 diff</summary>
                <pre>{change.diff}</pre>
              </details>
            ))}
          </div>
        )}

        {!isUser && message.previewChanges && message.previewChanges.length > 0 && (
          <div className="project-changes" aria-label="虚拟项目文件">
            <div className="project-changes-title">
              已生成 {message.previewChanges.length} 个虚拟文件（未修改本地源码）
            </div>
            {message.previewChanges.map((change) => (
              <details key={change.path} className="project-change">
                <summary>{change.path} · 查看 diff</summary>
                <pre>{change.diff}</pre>
              </details>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="preview-project-open"
              onClick={onPreviewProject}
            >
              在 Preview Worker 中预览
            </Button>
          </div>
        )}

        {!isUser && message.tokenUsage && message.tokenUsage.total_tokens > 0 && (
          <div className="token-usage">
            <span className="token-icon">📊</span>
            <span className="token-text">
              Token：输入 {message.tokenUsage.prompt_tokens}｜输出{' '}
              {message.tokenUsage.completion_tokens}｜合计 {message.tokenUsage.total_tokens}
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

        {generatedFiles.map((file) => (
          <a
            key={file.downloadUrl}
            className="file-download-card"
            href={file.downloadUrl}
            onClick={(event) => {
              if (!onPreviewFile) return;
              event.preventDefault();
              onPreviewFile(file);
            }}
          >
            <span className="file-icon">
              <GeneratedFileIcon type={file.fileType} />
            </span>
            <span className="file-info">
              <span className="file-name">{file.displayName}</span>
              <span className="file-action">在 Preview Worker 中打开</span>
            </span>
          </a>
        ))}

        {proxyVideoUrl && (
          <div className="video-player-container">
            <video className="video-player" src={proxyVideoUrl} controls preload="auto" playsInline>
              您的浏览器不支持视频播放
            </video>
          </div>
        )}

        {message.toolStatus ? (
          <div className="tool-status">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{message.toolStatus}</span>
          </div>
        ) : (
          <>
            {message.isStreaming && !displayContent && !finalVideoUrl && (
              <LoaderCircle
                className="h-4 w-4 animate-spin text-violet-300"
                aria-label="正在生成"
              />
            )}
            {message.isStreaming && displayContent && <span className="cursor-blink">▋</span>}
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

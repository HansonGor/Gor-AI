export interface Session {
  id: string;
  title: string;
  updated_at?: string;
  message_count?: number;
}

export type ThemeType = 'dark' | 'light';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  llm_call_count?: number;
  last_prompt_tokens?: number;
  calls?: Array<{
    index: number;
    prompt_tokens: number;
    completion_tokens: number;
    reason: string;
    contains_preview_committed_content?: boolean;
    contains_preview_file_changed_content?: boolean;
    contains_frontend_synced_full_source?: boolean;
    preview_source_chars?: number;
    search_snippet_chars?: number;
    range_read_chars?: number;
    full_preview_file_chars?: number;
    committed_content_chars?: number;
    preview_file_changed_chars?: number;
  }>;
  execution_llm_calls?: number;
  final_response_llm_calls?: number;
  preview_tool_calls?: number;
  search_calls?: number;
  search_queries?: string[];
  read_calls?: number;
  range_read_chars?: number;
  full_preview_file_chars?: number;
  read_reason?: string[];
  patch_calls?: number;
  batch_patch_calls?: number;
  patch_operations?: number;
  preview_commit_payload_bytes?: number;
  preview_sync_fetch_bytes?: number;
}

export interface ModelQuotaInfo {
  model_name: string;
  old_remain: number;
  cost_total: number;
  new_remain: number;
}

export interface ProjectChange {
  pending?: boolean;
  path: string;
  diff: string;
}

export interface PreviewFileChange extends ProjectChange {
  projectId: string;
  revision?: number;
}

export interface PreviewProjectSnapshot {
  messageId: string;
  id: string;
  name: string;
  template: 'react' | 'html' | 'presentation';
  /** Final preview artifact format (e.g. .html for React, .glb for a SceneSpec). */
  outputExtension: string;
  files: Record<string, string>;
  revision?: number;
  artifactId?: string;
  projectId?: string;
  snapshotId?: string;
  presentationSchema?: PresentationSchema;
  presentationBackgrounds?: Record<string, PresentationBackground>;
  renderedSlides?: PresentationRenderedSlide[];
  antiAIPatternReport?: Record<string, any>;
  designCritique?: Record<string, any>;
  finalArtifact?: GeneratedFile;
  storyOutline?: string[];
  visualQA?: {
    passed?: boolean;
    issues?: Array<{ severity: string; message: string }>;
    attempts?: number;
    maxAttempts?: number;
  };
}

export type PreviewProjectLabel = Pick<PreviewProjectSnapshot, 'id' | 'name' | 'template' | 'outputExtension'>;

export type PresentationMotionEffect =
  | 'none'
  | 'appear'
  | 'fade'
  | 'rise'
  | 'wipe'
  | 'fly'
  | 'zoom'
  | 'grow'
  | 'pulse'
  | 'colorEmphasis'
  | 'fadeOut';
export interface PresentationMotionCue {
  target: string;
  effect: PresentationMotionEffect;
  trigger: 'withPrevious' | 'afterPrevious' | 'onClick';
  start: number;
  duration: number;
  delay: number;
  order: number;
  clickIndex: number;
  direction: 'up' | 'left' | 'right' | 'down';
  distance: 'micro' | 'short' | 'medium';
}
export interface PresentationTransition {
  effect: 'none' | 'fade' | 'push' | 'wipe' | 'morph';
  duration: number;
  direction: 'up' | 'left' | 'right' | 'down';
  requestedEffect?: string | null;
  fallbackReason?: string | null;
}
export interface PresentationSchema {
  version: '1.0';
  title: string;
  description?: string;
  audience?: string;
  purpose?: string;
  artDirection?: Record<string, any>;
  designDNA?: Record<string, any>;
  referenceDesignProfile?: Record<string, any>;
  referencePlan?: {
    brief: { topic: string; language: 'zh' | 'en'; presentationType: string; industry: string; audience: string; style: string };
    sourceWeights: Array<{ source: string; baseWeight: number; scenarioRelevance: number; styleRelevance: number; languageRelevance: number; industryRelevance: number; audienceRelevance: number; formatRelevance: number; retrievalRelevance: number; rawWeight: number; finalWeight: number }>;
    primarySources: string[];
    secondarySources: string[];
    calibrationSources: string[];
    referenceIntent: Record<string, string[]>;
    blendedDNA: Record<string, string>;
    appliedDNA: Record<string, string>;
    layoutGrammar: string[];
    motionDirection: string;
    languageCalibration: { language: 'zh' | 'en'; fontFamily: string; titleScale: number; bodyLineSpacing: number; guidance: string };
    decisionTrace: Record<string, string>;
    providerStatus: string;
    userReferenceApplied: boolean;
    retrievedReferences: Array<{ source: string; title: string; url: string; snippet: string }>;
  } | null;
  theme: 'modern-light' | 'modern-dark' | 'business' | 'minimal' | 'technology';
  aspectRatio: '16:9' | '4:3';
  motionLanguage?: {
    style: 'minimal' | 'professional' | 'cinematic' | 'editorial' | 'dynamic' | 'data-driven';
    energy: 'low' | 'medium' | 'high';
    playback: 'automatic' | 'onClick' | 'none';
    maxAnimatedGroupsPerSlide: number;
    [key: string]: unknown;
  } | null;
  slides: Array<
    Record<string, any> & {
      id: string;
      type: string;
      title?: string;
      subtitle?: string;
      supportingPoints?: string[];
      transition?: PresentationTransition | null;
      animationTimeline?: PresentationMotionCue[] | null;
      motionDisabled?: boolean;
    }
  >;
}

export interface PresentationBackground {
  url: string;
  photographer: string;
  photographerUrl: string;
  photoUrl: string;
  imageRole?: 'hero' | 'background' | 'editorial' | 'product' | 'supporting' | 'texture' | 'none';
}

export interface PresentationRenderedSlide {
  slideId: string;
  index: number;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
}

export interface GeneratedFile {
  fileType: string;
  displayName: string;
  downloadUrl: string;
  artifactId?: string;
  projectId?: string;
  snapshotId?: string;
  messageId?: string;
  sessionId?: string;
  extension?: string;
  mimeType?: string;
  previewRenderer?: 'presentation' | string;
  editableSource?: boolean;
  presentationSchema?: PresentationSchema;
  presentationBackgrounds?: Record<string, PresentationBackground>;
  renderedSlides?: PresentationRenderedSlide[];
  antiAIPatternReport?: Record<string, any>;
  designCritique?: Record<string, any>;
  sourceFiles?: Record<string, string>;
  storyOutline?: string[];
  visualQA?: PreviewProjectSnapshot['visualQA'];
}

export interface UploadedAttachment {
  name: string;
  kind?: 'file' | 'folder' | 'archive';
  storageId?: string;
  previewStorageId?: string;
  downloadUrl?: string;
  size?: number;
}

export interface SearchSource {
  /** 来源编号，如 S1，对应回答正文中的 [S1] 引用标记 */
  sourceId?: string;
  title: string;
  url: string;
  snippet?: string;
  /** 真实域名（由后端从 URL 解析，如 xiaohongshu.com） */
  domain?: string;
  /** 来源平台/站点名（如小红书、GitHub） */
  source?: string;
  sourceType?: string;
  /** 实际返回该结果的 Search Provider（如 doubao / tavily / bocha / serper / github） */
  provider?: string;
  query?: string;
}

export interface SearchTraceEntry {
  provider: string;
  status: 'success' | 'empty' | 'error';
  error?: string;
  result_count?: number;
  domains?: string[];
}

export interface SearchTrace {
  /** 实际尝试过的 Provider（含失败/空结果） */
  attemptedProviders: string[];
  /** 实际成功返回结果的 Provider（不能把失败的也算成功） */
  successfulProvider: string[];
  /** 计划优先搜索的网站（≠ 实际搜索到的网站） */
  preferredDomains: string[];
  /** 实际获得结果的域名 */
  searchedDomains: string[];
  trace: SearchTraceEntry[];
}

export interface ChatMessage {
  thinkingTrace?: import('./utils/thinking').ThinkingTrace;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Request-only text context used for upload analysis; never rendered or persisted. */
  analysisContext?: string;
  attachments?: UploadedAttachment[];
  created_at?: string;
  images?: string[];
  isStreaming?: boolean;
  toolStatus?: string;
  /** Live, in-bubble execution phase; removed from view when the turn completes. */
  executionPhase?: 'thinking' | 'tool' | 'summarizing' | 'composing';
  executionToolName?: string;
  tokenUsage?: TokenUsage;
  contextRemain?: {
    prompt_tokens: number;
    max_context: number;
    remain_token: number;
    warning: boolean;
  };
  modelQuotaInfo?: ModelQuotaInfo;
  file?: GeneratedFile;
  files?: GeneratedFile[];
  videoUrl?: string;
  projectChanges?: ProjectChange[];
  previewChanges?: PreviewFileChange[];
  /** ChangeSet emitted for this assistant turn; provider selects its host adapter. */
  projectChangeSet?: { id: string; sessionId: string; provider: 'preview' | 'vscode' };
  projectChangeSetAmbiguous?: boolean;
  /** Turn-specific Virtual FS snapshot, persisted with the assistant message to prevent source mixing. */
  previewSnapshot?: PreviewProjectSnapshot;
  /** True when the list is reconstructed from the persisted project snapshot (legacy messages). */
  previewChangesRestored?: boolean;
  /** 本次回答真实使用的联网搜索来源（持久化，刷新后不重新搜索） */
  searchSources?: SearchSource[];
  /** 本次联网搜索的 Search Trace（attempted / successful providers） */
  searchTrace?: SearchTrace;
}

export interface SSEEvent {
  type: string;
  [key: string]: any;
}

export interface SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string) => void;
  theme?: ThemeType;
  isCollapsed?: boolean;
}

export interface ShareSelection {
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}
export interface ChatBoxProps {
  shareSelection?: ShareSelection;
  shareToolbar?: import('react').ReactNode;
  fileEditMode?: 'instant' | 'review';
  fileEditModeLoading?: boolean;
  onFileEditModeChange?: (mode: 'instant' | 'review') => void;
  thinkingMode?: 'light' | 'deep';
  thinkingModeLoading?: boolean;
  onThinkingModeChange?: (mode: 'light' | 'deep') => void;
  chatModelId?: string | null;
  chatModelLoading?: boolean;
  onChatModelChange?: (modelId: string) => void;
  messages: ChatMessage[];
  currentPreviewProject?: PreviewProjectLabel;
  input: string;
  setInput: (value: string) => void;
  pendingImages: Array<{ name: string; base64: string }>;
  pendingUploadAttachments?: UploadedAttachment[];
  isLoading: boolean;
  handleSend: (text?: string) => void;
  handleStop: () => void;
  handleImageSelect: (files: FileList | File[]) => void;
  removePendingImage: (index: number) => void;
  onPreviewFile?: (file: GeneratedFile) => void;
  onPreviewProject?: (
    file?: GeneratedFile,
    intent?: 'preview' | 'source',
    sourcePath?: string,
    snapshot?: PreviewProjectSnapshot,
  ) => void;
  onPreviewAttachment?: (attachment: UploadedAttachment) => void;
  onArchiveSelect?: (file: File, signal?: AbortSignal) => Promise<void>;
  onFolderSelect?: (files: FileList | File[], signal?: AbortSignal) => Promise<void>;
  onUploadImages?: (files: File[]) => Promise<void>;
  importedUploadName?: string | null;
  hasPendingUploadSummary?: boolean;
  onRemoveImportedUpload?: () => void;
  onClearPendingUpload?: () => void;
}

export interface InputAreaProps {
  fileEditMode?: 'instant' | 'review';
  fileEditModeLoading?: boolean;
  onFileEditModeChange?: (mode: 'instant' | 'review') => void;
  thinkingMode?: 'light' | 'deep';
  thinkingModeLoading?: boolean;
  onThinkingModeChange?: (mode: 'light' | 'deep') => void;
  chatModelId?: string | null;
  chatModelLoading?: boolean;
  onChatModelChange?: (modelId: string) => void;
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  pendingImages: Array<{ name: string; base64: string }>;
  pendingUploadAttachments?: UploadedAttachment[];
  onSend: (text?: string) => void;
  onStop: () => void;
  onImageSelect: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
  onArchiveSelect?: (file: File, signal?: AbortSignal) => Promise<void>;
  onFolderSelect?: (files: FileList | File[], signal?: AbortSignal) => Promise<void>;
  onUploadImages?: (files: File[]) => Promise<void>;
  importedUploadName?: string | null;
  hasPendingUploadSummary?: boolean;
  onRemoveImportedUpload?: () => void;
  onClearPendingUpload?: () => void;
}

export interface MessageListProps {
  shareSelection?: ShareSelection;
  messages: ChatMessage[];
  currentPreviewProject?: PreviewProjectLabel;
  onPreviewFile?: (file: GeneratedFile) => void;
  onPreviewProject?: (
    file?: GeneratedFile,
    intent?: 'preview' | 'source',
    sourcePath?: string,
    snapshot?: PreviewProjectSnapshot,
  ) => void;
  onPreviewAttachment?: (attachment: UploadedAttachment) => void;
}
export interface MessageBubbleProps {
  message: ChatMessage;
  currentPreviewProject?: PreviewProjectLabel;
  uploadedAttachments?: UploadedAttachment[];
  onPreviewFile?: (file: GeneratedFile) => void;
  onPreviewProject?: (
    file?: GeneratedFile,
    intent?: 'preview' | 'source',
    sourcePath?: string,
    snapshot?: PreviewProjectSnapshot,
  ) => void;
  onPreviewAttachment?: (attachment: UploadedAttachment) => void;
}
export interface WelcomeScreenProps {
  onPromptClick: (text: string) => void;
}

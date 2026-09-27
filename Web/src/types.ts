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
}

export interface ModelQuotaInfo {
  model_name: string;
  old_remain: number;
  cost_total: number;
  new_remain: number;
}

export interface ProjectChange {
  path: string;
  diff: string;
}

export interface PreviewFileChange extends ProjectChange {
  projectId: string;
}

export interface PreviewProjectSnapshot {
  messageId: string;
  id: string;
  name: string;
  template: 'react' | 'html';
  /** Final preview artifact format (e.g. .html for React, .glb for a SceneSpec). */
  outputExtension: string;
  files: Record<string, string>;
}

export interface GeneratedFile {
  fileType: string;
  displayName: string;
  downloadUrl: string;
}

export interface UploadedAttachment {
  name: string;
  kind?: 'file' | 'folder' | 'archive';
  storageId?: string;
  previewStorageId?: string;
  downloadUrl?: string;
  size?: number;
}

export interface ChatMessage {
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
  tokenUsage?: TokenUsage;
  contextRemain?: { prompt_tokens: number; max_context: number; remain_token: number; warning: boolean };
  modelQuotaInfo?: ModelQuotaInfo;
  file?: GeneratedFile;
  files?: GeneratedFile[];
  videoUrl?: string;
  projectChanges?: ProjectChange[];
  previewChanges?: PreviewFileChange[];
  /** Turn-specific Virtual FS snapshot, persisted with the assistant message to prevent source mixing. */
  previewSnapshot?: PreviewProjectSnapshot;
  /** True when the list is reconstructed from the persisted project snapshot (legacy messages). */
  previewChangesRestored?: boolean;
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

export interface ChatBoxProps {
  messages: ChatMessage[];
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
  onPreviewProject?: (file?: GeneratedFile, intent?: 'preview' | 'source', sourcePath?: string, snapshot?: PreviewProjectSnapshot) => void;
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

export interface MessageListProps { messages: ChatMessage[]; onPreviewFile?: (file: GeneratedFile) => void; onPreviewProject?: (file?: GeneratedFile, intent?: 'preview' | 'source', sourcePath?: string, snapshot?: PreviewProjectSnapshot) => void; onPreviewAttachment?: (attachment: UploadedAttachment) => void; }
export interface MessageBubbleProps { message: ChatMessage; uploadedAttachments?: UploadedAttachment[]; onPreviewFile?: (file: GeneratedFile) => void; onPreviewProject?: (file?: GeneratedFile, intent?: 'preview' | 'source', sourcePath?: string, snapshot?: PreviewProjectSnapshot) => void; onPreviewAttachment?: (attachment: UploadedAttachment) => void; }
export interface WelcomeScreenProps { onPromptClick: (text: string) => void }

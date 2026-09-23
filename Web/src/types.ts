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

export interface GeneratedFile {
  fileType: string;
  displayName: string;
  downloadUrl: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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
  isCollapsed?: boolean;
}

export interface ChatBoxProps {
  messages: ChatMessage[];
  input: string;
  setInput: (value: string) => void;
  pendingImages: Array<{ name: string; base64: string }>;
  isLoading: boolean;
  handleSend: (text?: string) => void;
  handleStop: () => void;
  handleImageSelect: (files: FileList | File[]) => void;
  removePendingImage: (index: number) => void;
  onPreviewFile?: (file: GeneratedFile) => void;
  onPreviewProject?: () => void;
}

export interface InputAreaProps {
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  pendingImages: Array<{ name: string; base64: string }>;
  onSend: (text?: string) => void;
  onStop: () => void;
  onImageSelect: (files: FileList | File[]) => void;
  onRemoveImage: (index: number) => void;
}

export interface MessageListProps { messages: ChatMessage[]; onPreviewFile?: (file: GeneratedFile) => void; onPreviewProject?: () => void; }
export interface MessageBubbleProps { message: ChatMessage; onPreviewFile?: (file: GeneratedFile) => void; onPreviewProject?: () => void; }
export interface WelcomeScreenProps { onPromptClick: (text: string) => void }

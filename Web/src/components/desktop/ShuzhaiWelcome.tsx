import { FolderOpen, LampDesk } from 'lucide-react';
import type { ShuzhaiRecent } from '../../desktop/desktopRuntime';
import './Shuzhai.less';

export type ShuzhaiWelcomeProps = {
  recent: ShuzhaiRecent[];
  busy?: boolean;
  /** 上一次选择失败的原因（如选了整个磁盘）；没有时不显示。 */
  error?: string | null;
  onPickFolder: () => void;
  onOpenRecent: (folderPath: string) => void;
};

function relativeDay(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 纯展示：书斋模式尚未选择文件夹时的空状态「择一书斋」。 */
export default function ShuzhaiWelcome({ recent, busy = false, error, onPickFolder, onOpenRecent }: ShuzhaiWelcomeProps) {
  return (
    <section className="shuzhai-welcome" aria-labelledby="shuzhai-welcome-title">
      <span className="shuzhai-welcome-icon"><LampDesk aria-hidden="true" /></span>
      <h2 id="shuzhai-welcome-title">择一书斋</h2>
      <p className="shuzhai-welcome-desc">
        把本机的一个项目文件夹设为书斋，Gor 就能直接读写其中的文件、运行测试与构建。改动都会在 Diff 里列出，可以撤销。
      </p>
      <button type="button" className="shuzhai-welcome-primary" disabled={busy} onClick={onPickFolder}>
        <FolderOpen aria-hidden="true" />打开文件夹…
      </button>
      {error && <p className="shuzhai-welcome-error" role="alert">{error}</p>}
      {recent.length > 0 && (
        <div className="shuzhai-welcome-recent">
          <h3>最近的书斋</h3>
          {recent.map((item) => (
            <button key={item.path} type="button" className="shuzhai-recent" disabled={busy} title={item.path}
              onClick={() => onOpenRecent(item.path)}>
              <span className="shuzhai-recent-copy"><strong>{item.name}</strong><span>{item.path}</span></span>
              <span className="shuzhai-recent-time">{relativeDay(item.openedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

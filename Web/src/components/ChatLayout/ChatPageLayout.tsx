import type { ReactNode } from 'react';

export interface ChatPageLayoutProps {
  className: string;
  brand?: ReactNode;
  sidebar?: ReactNode;
  header?: ReactNode;
  children: ReactNode;
}

/** Shared page frame for the web chat and the VS Code webview chat. */
export default function ChatPageLayout({
  className,
  brand,
  sidebar,
  header,
  children,
}: ChatPageLayoutProps) {
  return (
    <div className={`chat-page ${className}`.trim()}>
      {brand && <div className="gor-brand chat-persistent-brand">{brand}</div>}
      {sidebar}
      <div className="chat-main-content">
        {header}
        <main className="chat-main">{children}</main>
      </div>
    </div>
  );
}

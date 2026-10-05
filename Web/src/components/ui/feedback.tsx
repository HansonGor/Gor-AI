import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { Button } from './button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';

type NoticeTone = 'success' | 'error';
type AlertContent = { title: string; description: string };
type FeedbackContextValue = {
  notify: (message: string, tone?: NoticeTone) => void;
  alert: (content: AlertContent) => void;
};

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<{ id: number; message: string; tone: NoticeTone } | null>(
    null,
  );
  const [alertContent, setAlertContent] = useState<AlertContent | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const notify = useCallback((message: string, tone: NoticeTone = 'error') => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    setNotice({ id: Date.now(), message, tone });
    timeoutRef.current = window.setTimeout(() => setNotice(null), 2600);
  }, []);
  const alert = useCallback((content: AlertContent) => setAlertContent(content), []);
  const value = useMemo(() => ({ notify, alert }), [notify, alert]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {notice && (
        <div
          role="status"
          className="chat-theme-toast fixed left-1/2 top-5 z-[120] flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2 rounded-lg border border-white/10 px-4 py-3 text-sm text-white shadow-xl backdrop-blur-xl"
        >
          {notice.tone === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          ) : (
            <AlertCircle className="h-4 w-4 text-rose-400" />
          )}
          <span>{notice.message}</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-1 h-6 w-6 text-white/60 hover:bg-white/10 hover:text-white"
            onClick={() => setNotice(null)}
            aria-label="关闭提示"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <AlertDialog
        open={alertContent !== null}
        onOpenChange={(open) => {
          if (!open) setAlertContent(null);
        }}
      >
        <AlertDialogContent overlayClassName="chat-theme-dialog-overlay" className="chat-theme-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{alertContent?.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-[#dce5ff]/70">
              {alertContent?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setAlertContent(null)}>我知道了</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackContextValue {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error('useFeedback must be used inside FeedbackProvider.');
  return value;
}

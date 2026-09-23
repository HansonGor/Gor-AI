// 视频任务轮询 Hook
// 负责轮询视频生成任务状态，任务完成后通知回调
import { useRef, useCallback } from 'react';
import { getVideoTasks } from '../api/chat';
import { VIDEO_CONFIG } from '../config';

const { POLL_INTERVAL, MAX_POLLS } = VIDEO_CONFIG;

interface VideoTask {
  id: string;
  status: string;
  video_url?: string;
}

export function useVideoPolling() {
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastVideoTaskIdRef = useRef<string | null>(null);

  /**
   * 停止视频任务轮询
   */
  const stopVideoPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /**
   * 开始视频任务轮询
   */
  const startVideoPolling = useCallback(
    (onVideoReady: (videoUrl: string) => void, onStatusChange?: (status: string) => void) => {
      stopVideoPolling();
      lastVideoTaskIdRef.current = null;
      let pollCount = 0;

      pollTimerRef.current = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          stopVideoPolling();
          onStatusChange?.('视频生成超时');
          return;
        }

        try {
          const tasks: VideoTask[] = await getVideoTasks();
          const runningTask = tasks.find(
            (t) => t.status === 'running' || t.status === 'pending'
          );

          if (runningTask && runningTask.id !== lastVideoTaskIdRef.current) {
            lastVideoTaskIdRef.current = runningTask.id;
            onStatusChange?.(`视频渲染中... (${(pollCount * POLL_INTERVAL) / 1000}s)`);
          }

          const doneTask = tasks.find((t) => t.status === 'done' && t.video_url);
          if (doneTask && doneTask.video_url) {
            stopVideoPolling();
            onStatusChange?.('视频生成完成');
            onVideoReady?.(doneTask.video_url);
          }
        } catch (err) {
          console.error('[VideoPolling] 轮询视频任务失败:', err);
        }
      }, POLL_INTERVAL);
    },
    [stopVideoPolling]
  );

  /**
   * 清理资源（组件卸载时调用）
   */
  const cleanup = useCallback(() => {
    stopVideoPolling();
  }, [stopVideoPolling]);

  return {
    startVideoPolling,
    stopVideoPolling,
    cleanup,
  };
}

export default useVideoPolling;

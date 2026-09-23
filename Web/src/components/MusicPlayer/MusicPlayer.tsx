// 音乐播放器：首页入口按钮 + 悬浮播放器弹窗
// 数据源：后端 /api/music/random（后端转发 Jamendo API，前端不接触 client_id）
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Music, SkipBack, Play, Pause, SkipForward, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MusicTrack {
  name: string;
  artist: string;
  cover: string;
  audio: string;
  duration: number;
}

/** 秒 → mm:ss */
function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const MusicPlayer: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [track, setTrack] = useState<MusicTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0); // 0-100
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current) audioRef.current = new Audio();

  /** 请求后端随机曲目并播放 */
  const loadRandom = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/music/random');
      if (!res.ok) throw new Error('bad status');
      const data: MusicTrack = await res.json();
      if (!data.audio) throw new Error('no audio');
      setTrack(data);
      setProgress(0);
      setCurrentTime(0);
      const audio = audioRef.current!;
      audio.src = data.audio;
      await audio.play();
      setPlaying(true);
    } catch {
      setError('音乐加载失败');
      setPlaying(false);
    } finally {
      setLoading(false);
    }
  }, []);

  /** 播放 / 暂停：仅控制本地音频实例，不请求后端 */
  const togglePlay = useCallback(() => {
    const audio = audioRef.current!;
    if (!track) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => setError('播放失败'));
      setPlaying(true);
    }
  }, [playing, track]);

  /** 上一首 / 下一首：重新请求后端随机新曲 */
  const changeTrack = useCallback(() => {
    loadRandom();
  }, [loadRandom]);

  /** 点击入口：打开弹窗，首次自动拉取并播放 */
  const openPanel = useCallback(() => {
    setOpen(true);
    if (!track && !loading) loadRandom();
  }, [track, loading, loadRandom]);

  /** 进度条与播放结束监听 */
  useEffect(() => {
    const audio = audioRef.current!;
    const onTime = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setProgress((audio.currentTime / audio.duration) * 100);
        setCurrentTime(audio.currentTime);
      }
    };
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    };
    const onError = () => {
      if (track) setError('音频加载失败');
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [track]);

  /** 点击进度条跳转 */
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const audio = audioRef.current!;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
      setProgress(ratio * 100);
    }
  };

  return (
    <>
      {/* 顶部入口按钮：圆形深色玻璃拟态，与铃铛同尺寸 */}
      <button
        onClick={openPanel}
        aria-label="音乐播放器"
        title="音乐播放器"
        className={cn(
          'glass-pill relative flex h-[0.8rem] w-[0.8rem] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 text-white transition-transform active:scale-95',
          playing && 'music-playing'
        )}
      >
        {playing ? (
          // 播放中：显示 App Logo 并优雅旋转
          <img
            src="/icon-192.png"
            alt="Gor"
            className="music-logo-spin h-[0.58rem] w-[0.58rem] rounded-full object-cover"
          />
        ) : (
          <Music className="h-[0.34rem] w-[0.34rem]" />
        )}
      </button>

      {/* 悬浮播放器弹窗 */}
      {open && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-[0.4rem]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          role="dialog"
          aria-label="音乐播放器"
        >
          <div className="music-panel w-full max-w-[7.6rem] rounded-[0.4rem] border border-white/10 bg-[rgba(20,20,32,0.92)] p-[0.4rem] shadow-[0_0.12rem_0.5rem_rgba(0,0,0,0.6)] backdrop-blur-xl">
            {/* 顶部：封面 + 歌名/歌手 + 关闭 */}
            <div className="flex items-center gap-[0.28rem]">
              <div className="h-[1.5rem] w-[1.5rem] flex-shrink-0 overflow-hidden rounded-[0.28rem] bg-white/10">
                {track?.cover ? (
                  <img src={track.cover} alt="封面" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-white/30">
                    <Music className="h-[0.5rem] w-[0.5rem]" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-[0.3rem] font-semibold text-white">
                  {track?.name || (loading ? '加载中…' : '未选择歌曲')}
                </p>
                <p className="m-0 mt-[0.06rem] truncate text-[0.24rem] text-white/50">
                  {track?.artist || ''}
                </p>
                {error && <p className="m-0 mt-[0.06rem] text-[0.22rem] text-rose-400">{error}</p>}
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="关闭播放器"
                className="flex h-[0.56rem] w-[0.56rem] shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
              >
                <X className="h-[0.28rem] w-[0.28rem]" />
              </button>
            </div>

            {/* 进度条 */}
            <div className="mt-[0.32rem]">
              <div
                className="h-[0.08rem] w-full cursor-pointer overflow-hidden rounded-full bg-white/10"
                onClick={handleSeek}
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#8b5cf6] to-[#a78bfa]"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-[0.08rem] flex justify-between text-[0.2rem] text-white/40">
                <span>{formatTime(currentTime)}</span>
                <span>{track?.duration ? formatTime(track.duration) : '0:00'}</span>
              </div>
            </div>

            {/* 控制按钮 */}
            <div className="mt-[0.28rem] flex items-center justify-center gap-[0.4rem]">
              <button
                onClick={changeTrack}
                aria-label="上一首"
                className="flex h-[0.64rem] w-[0.64rem] cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-40"
                disabled={loading}
              >
                <SkipBack className="h-[0.3rem] w-[0.3rem]" />
              </button>
              <button
                onClick={togglePlay}
                aria-label={playing ? '暂停' : '播放'}
                disabled={!track || loading}
                className="flex h-[0.84rem] w-[0.84rem] cursor-pointer items-center justify-center rounded-full bg-gradient-to-br from-[#8b5cf6] to-[#a78bfa] text-white shadow-[0_0.06rem_0.24rem_rgba(139,92,246,0.4)] transition-transform active:scale-95 disabled:opacity-40"
              >
                {loading ? (
                  <span className="h-[0.3rem] w-[0.3rem] animate-spin rounded-full border-[0.04rem] border-white/30 border-t-white" />
                ) : playing ? (
                  <Pause className="h-[0.36rem] w-[0.36rem]" />
                ) : (
                  <Play className="ml-[0.04rem] h-[0.36rem] w-[0.36rem]" />
                )}
              </button>
              <button
                onClick={changeTrack}
                aria-label="下一首"
                className="flex h-[0.64rem] w-[0.64rem] cursor-pointer items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-40"
                disabled={loading}
              >
                <SkipForward className="h-[0.3rem] w-[0.3rem]" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default MusicPlayer;

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  Target,
  BookOpen,
  Dumbbell,
  // Bell, // 通知铃铛：暂隐藏，恢复时取消注释
  Home,
  Compass,
  Plus,
  BarChart3,
  User,
  TrendingUp,
  Sun,
  Cloud,
  CloudSun,
  CloudRain,
  CloudSnow,
  CloudFog,
  CloudLightning,
  CloudDrizzle,
  Wind,
  Tornado,
  type LucideIcon,
} from 'lucide-react';
// import { Badge } from '@/components/ui/badge'; // 通知铃铛角标：暂隐藏，恢复时取消注释
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import AppAvatar from '@/components/AppAvatar';
import MusicPlayer from '@/components/MusicPlayer/MusicPlayer';
import { useWeather } from '@/hooks/useWeather';
import { cn } from '@/lib/utils';
import './index.less';

/** 功能卡片数据 */
const featureCards = [
  {
    icon: Sparkles,
    title: 'AI Chat',
    desc: 'Start a conversation with AI',
    tag: 'AI Assistant',
    tagColor: '#a78bfa',
    to: '/chat',
  },
  {
    icon: Target,
    title: 'Set Intention',
    desc: "Define today's top priorities",
    tag: '3 priorities',
    tagColor: '#f472b6',
  },
  {
    icon: BookOpen,
    title: 'Journal',
    desc: 'Reflect & capture your thoughts',
    tag: 'Last: Today',
    tagColor: '#60a5fa',
  },
  {
    icon: Dumbbell,
    title: 'Move Body',
    desc: 'Start a quick workout',
    tag: '12 min',
    tagColor: '#34d399',
  },
];

/** 底部导航数据 */
const navItems = [
  { icon: Home, label: 'Home', active: true },
  { icon: Compass, label: 'Discover', active: false },
  { icon: Plus, label: '', active: false, isCenter: true },
  { icon: BarChart3, label: 'Activity', active: false },
  { icon: User, label: 'Profile', active: false },
];

/** 天气图标映射（lucide-react） */
const WEATHER_ICON_MAP: Record<string, LucideIcon> = {
  sun: Sun,
  cloud: Cloud,
  'cloud-sun': CloudSun,
  'cloud-rain': CloudRain,
  'cloud-snow': CloudSnow,
  'cloud-fog': CloudFog,
  'cloud-lightning': CloudLightning,
  'cloud-drizzle': CloudDrizzle,
  wind: Wind,
  tornado: Tornado,
};

/** 根据当地时间返回问候语 */
function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const HomePage: React.FC = () => {
  const { data: weather, status: weatherStatus, retry: retryWeather } = useWeather();
  const greeting = getGreeting();
  const navigate = useNavigate();

  // 卡片点击：配置了 to 的卡片跳转对应路由
  const handleCardClick = (to?: string) => {
    if (to) navigate(to);
  };

  // 解除全局 body overflow:hidden，允许首页上下滚动
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    const originalOverflowX = document.body.style.overflowX;
    document.body.style.overflow = 'auto';
    document.body.style.overflowX = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
      document.body.style.overflowX = originalOverflowX;
    };
  }, []);

  return (
    <div className="home-page dark min-h-screen bg-background text-foreground">
      {/* 顶部状态栏区域 */}
      <header className="home-header flex items-center justify-between px-[0.4rem] pb-[0.4rem]" style={{ paddingTop: 'calc(0.3rem + env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-[0.24rem]">
          <AppAvatar className="glass-pill h-[0.96rem] w-[0.96rem] border-0" />
          <Button
            type="button"
            variant="ghost"
            className="glass-pill h-auto flex items-center gap-[0.1rem] rounded-[0.4rem] px-[0.28rem] py-[0.14rem] text-inherit hover:bg-white/5"
            onClick={retryWeather}
            aria-label="点击刷新天气"
            title="点击刷新天气"
          >
            {weatherStatus === 'loading' && (
              <span className="text-[0.24rem] font-medium text-white/60">正在获取天气…</span>
            )}
            {weatherStatus === 'error' && (
              <span className="text-[0.24rem] font-medium text-white/50">天气获取失败，点击重试</span>
            )}
            {weatherStatus === 'success' && weather && (
              <>
                {(() => {
                  const WeatherIcon = WEATHER_ICON_MAP[weather.iconKey] || Cloud;
                  return <WeatherIcon className="h-[0.32rem] w-[0.32rem] text-white/90" />;
                })()}
                <span className="text-[0.24rem] font-medium text-white/80">
                  {weather.city}, {weather.temperature}℃
                </span>
              </>
            )}
          </Button>
        </div>
        {/* 通知铃铛：暂隐藏，后续如需恢复取消注释即可 */}
        {/* <Button
          variant="ghost"
          size="icon"
          className="glass-pill relative h-[0.8rem] w-[0.8rem] rounded-full text-white hover:bg-transparent"
          aria-label="通知"
        >
          <Bell className="h-[0.34rem] w-[0.34rem]" />
          <Badge className="absolute right-[0.08rem] top-[0.08rem] flex h-[0.3rem] min-w-[0.3rem] items-center justify-center rounded-[0.15rem] bg-red-500 px-[0.06rem] text-[0.18rem] font-semibold text-white">
            2
          </Badge>
        </Button> */}
        {/* 音乐播放器入口（原铃铛右侧） */}
        <MusicPlayer />
      </header>

      {/* 主内容区 */}
      <main className="flex-1 px-[0.4rem]">
        {/* 问候语 */}
        <section className="py-[0.4rem] pb-[0.6rem]" aria-label="问候语">
          <h1 className="m-0 text-[1.12rem] font-bold leading-[1.05] tracking-[-0.02rem] text-white" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
            {greeting.split(' ')[0]}
            <br />
            {greeting.split(' ')[1]}
          </h1>
          <p className="mt-[0.24rem] text-[0.3rem] font-normal text-white/50">
            What can I Do for you? <span className="sparkle">✨</span>
          </p>
        </section>

        {/* 功能卡片网格 */}
        <section className="mb-[0.32rem] grid grid-cols-2 gap-[0.32rem]" aria-label="快捷功能">
          {featureCards.map((card, index) => (
            <Card
              key={index}
              onClick={() => handleCardClick(card.to)}
              className="glass-card cursor-pointer transition-transform active:scale-[0.97]"
            >
              <CardContent className="flex flex-col p-[0.36rem]">
                <div className="glass-icon-circle mb-[0.28rem] flex h-[0.8rem] w-[0.8rem] items-center justify-center rounded-full">
                  <card.icon className="h-[0.38rem] w-[0.38rem] text-white" />
                </div>
                <div className="flex-1">
                  <h3 className="m-0 mb-[0.08rem] text-[0.32rem] font-semibold text-white">{card.title}</h3>
                  <p className="m-0 text-[0.24rem] leading-[1.4] text-white/50">{card.desc}</p>
                </div>
                <div className="mt-[0.24rem] flex items-center gap-[0.1rem] text-[0.22rem] font-medium" style={{ color: card.tagColor }}>
                  <span className="h-[0.14rem] w-[0.14rem] rounded-full" style={{ backgroundColor: card.tagColor }} />
                  {card.tag}
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* 每日进度卡片 */}
        <Card className="glass-card rounded-[0.4rem]" aria-label="每日进度">
          <CardContent className="flex items-center gap-[0.32rem] p-[0.36rem]">
            <div className="relative h-[1.2rem] w-[1.2rem] flex-shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="6" />
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 42}`}
                  strokeDashoffset={`${2 * Math.PI * 42 * (1 - 0.72)}`}
                />
              </svg>
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[0.36rem]">☀️</span>
            </div>
            <div className="flex-1">
              <h3 className="m-0 mb-[0.06rem] text-[0.3rem] font-semibold text-white">Daily Progress</h3>
              <p className="m-0 text-[0.24rem] text-white/50">You're building momentum</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="flex-shrink-0 rounded-[0.3rem] bg-white/10 px-[0.24rem] py-[0.16rem] text-[0.26rem] font-semibold text-white hover:bg-white/[0.15]"
            >
              <TrendingUp className="mr-[0.08rem] h-[0.28rem] w-[0.28rem]" />
              72%
            </Button>
          </CardContent>
        </Card>
      </main>

      {/* 底部导航栏 */}
      <nav className="glass-nav fixed bottom-0 left-0 right-0 z-100 flex items-center justify-around px-[0.4rem] py-[0.2rem]" style={{ paddingBottom: 'calc(0.2rem + env(safe-area-inset-bottom))' }} aria-label="主导航">
        {navItems.map((item, index) =>
          item.isCenter ? (
            <Button
              key={index}
              variant="ghost"
              size="icon"
              className="mt-[-0.5rem] flex h-[1rem] w-[1rem] items-center justify-center rounded-full bg-white text-black shadow-[0_0.08rem_0.3rem_rgba(255,255,255,0.3)]"
              aria-label="新建"
            >
              <item.icon className="h-[0.5rem] w-[0.5rem] font-light" />
            </Button>
          ) : (
            <Button
              key={index}
              variant="ghost"
              className={cn(
                'flex flex-col items-center gap-[0.06rem] px-[0.2rem] py-[0.1rem] text-white/40 hover:bg-transparent hover:text-white',
                item.active && 'text-white'
              )}
              aria-label={item.label}
            >
              <item.icon className="h-[0.4rem] w-[0.4rem]" />
              <span className="text-[0.2rem] font-medium">{item.label}</span>
            </Button>
          )
        )}
      </nav>
    </div>
  );
};

export default HomePage;

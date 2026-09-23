// 欢迎页（空状态）— shadcn 组件：Avatar + Card + Button
import { Sparkles } from 'lucide-react';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { QUICK_PROMPTS } from './quickPrompts';
import type { WelcomeScreenProps } from '../../types';

export default function WelcomeScreen({ onPromptClick }: WelcomeScreenProps) {
  return (
    <div className="welcome-screen">
      {/* 助手形象：无底色 Sparkles 图标（颜色由主题控制：暗色银 / 亮色深紫） */}
      <Avatar className="h-[1.1rem] w-[1.1rem] rounded-[0.3rem] bg-transparent">
        <AvatarFallback className="bg-transparent">
          <Sparkles className="welcome-sparkles h-[0.58rem] w-[0.58rem]" strokeWidth={1.6} />
        </AvatarFallback>
      </Avatar>

      <h2 className="welcome-title">你好，我是AI助手</h2>
      <p className="welcome-desc">
        我可以查询新闻、美食、音乐、科普知识、社会热点，支持联网获取实时信息，陪你闲聊对话。
      </p>

      {/* 快捷问题卡片 */}
      <Card className="quick-prompts-card w-full max-w-[8rem] border-white/10 bg-white/[0.05] shadow-none backdrop-blur-xl">
        <CardContent className="flex flex-col gap-[0.16rem] p-[0.24rem]">
          {QUICK_PROMPTS.map((text, i) => (
            <Button
              key={i}
              variant="ghost"
              onClick={() => onPromptClick(text)}
              className="h-auto w-full justify-start rounded-[0.24rem] px-[0.24rem] py-[0.2rem] text-left text-[0.26rem] font-normal leading-snug text-white/85 hover:bg-white/10 hover:text-white"
            >
              <span className="mr-[0.14rem] text-[0.3rem] leading-none text-indigo-300/80">·</span>
              {text}
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// 主应用组件：react-router 前端路由
// HashRouter：/ 首页、/chat AI 对话页；未知路径重定向首页
import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import ChatPage from './pages/chat/ChatPage';

const HomePage = lazy(() => import('./pages/home'));
const CodeDemoPage = lazy(() => import('./pages/code'));
const WeatherPage = lazy(() => import('./pages/weather'));

export default function App() {
  return (
    <HashRouter>
      <Suspense fallback={<div className="app-loading">页面加载中...</div>}><Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/code" element={<CodeDemoPage />} />
        <Route path="/weather" element={<WeatherPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense>
    </HashRouter>
  );
}

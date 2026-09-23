// 前端全局配置
// 所有常量集中管理，避免分散在各组件中

// ========== API 配置 ==========
export const API_CONFIG = {
  chatEndpoint: '/api/chat',
  healthEndpoint: '/api/health',
  videoProxyEndpoint: '/api/video/proxy',
  weatherEndpoint: '/api/weather',
};

// ========== 高德地图配置 ==========
export const AMAP_CONFIG = {
  // 高德 JSAPI Key（前端定位用，需配合安全密钥）
  JS_API_KEY: import.meta.env.VITE_AMAP_JS_API_KEY || '',
  // 高德 JSAPI 安全密钥（JSAPI 2.0 必需）
  JS_CODE: import.meta.env.VITE_AMAP_JS_CODE || '',
};

// ========== 布局配置 ==========
export const LAYOUT_CONFIG = {
  // PC 断点：≥1024px 为 PC 双栏布局，≤1023px 为手机/平板悬浮侧边栏
  PC_BREAKPOINT: 1024,
  // 侧边栏宽度
  SIDEBAR_WIDTH: '5rem',
  SIDEBAR_WIDTH_COLLAPSED: '1.2rem',
};

// ========== 本地存储 Key ==========
export const STORAGE_KEYS = {
  // 侧边栏折叠状态
  SIDEBAR_OPEN: 'app_sidebar_open',
  // 主题状态
  THEME: 'app_theme',
};

// ========== 聊天配置 ==========
export const CHAT_CONFIG = {
  // 默认用户ID
  DEFAULT_USER_ID: 'default',
  // 输入最大长度
  MAX_INPUT_LENGTH: 2000,
  // 输入框最大高度
  INPUT_MAX_HEIGHT: 120,
};

// ========== 模型配置 ==========
export const MODEL_CONFIG = {
  // 模型额度告警阈值（剩余 token ≤ 该值时弹出提醒）
  QUOTA_WARNING_THRESHOLD: 20000,
  // 上下文剩余告警阈值
  CONTEXT_WARNING_THRESHOLD: 10000,
  // 对话模型最大上下文窗口
  MAX_CONTEXT_TOKENS: 479284,
};

// ========== 用户配置 ==========
export const USER_CONFIG = {
  // 用户头像（网络链接）
  AVATAR_URL: 'https://github.com/HansonGor.png',
};

// ========== 视频配置 ==========
export const VIDEO_CONFIG = {
  // 视频文件扩展名
  EXTENSIONS: ['.mp4', '.webm', '.ogg', '.mov', '.m4v'],
  // 视频域名关键词
  DOMAINS: ['aigc-cloud.com', 'volcengine.com', 'bytecdn.cn', 'toutiaoimg.com'],
  // 轮询间隔（毫秒）
  POLL_INTERVAL: 5000,
  // 最大轮询次数
  MAX_POLLS: 360,
};

// ========== 主题配置 ==========
export const THEME_CONFIG = {
  DARK: 'dark',
  LIGHT: 'light',
  DEFAULT: 'dark',
};

// 兼容旧版导出
export const config = {
  api: API_CONFIG,
  chat: CHAT_CONFIG,
};

export default config;

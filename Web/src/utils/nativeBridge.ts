/**
 * Native 桥接工具
 * Web 端通过 postMessage 调用 React Native 方法
 *
 * 支持两种环境：
 * 1. Native WebView（Expo Go）：window.ReactNativeWebView.postMessage
 * 2. iframe（RN web 端编译）：window.parent.postMessage
 */

/** 定位结果 */
export interface NativeGeolocationResult {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: number;
}

/** 定位错误 */
export interface NativeGeolocationError {
  message: string;
  code?: string;
}

interface NativeMessage {
  type: string;
  payload?: unknown;
}

/** 消息类型常量（与 Native 端 modules/geolocation/types.ts 保持一致） */
const GEOLOCATION_REQUEST = 'geolocation:request';
const GEOLOCATION_SUCCESS = 'geolocation:success';
const GEOLOCATION_ERROR = 'geolocation:error';

/** 定位超时时间（毫秒） */
const GEOLOCATION_TIMEOUT = 15000;

/** 是否运行在 React Native WebView 中 */
function isNativeWebView(): boolean {
  return typeof window !== 'undefined' && !!(window as any).ReactNativeWebView;
}

/** 是否运行在 iframe 中（RN web 端编译） */
function isInIframe(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    return false;
  }
}

function send(message: NativeMessage): boolean {
  // Native WebView 环境
  if (isNativeWebView()) {
    (window as any).ReactNativeWebView.postMessage(JSON.stringify(message));
    return true;
  }
  // iframe 环境（RN web 端）：通知父页面
  if (isInIframe()) {
    window.parent.postMessage(JSON.stringify(message), '*');
    return true;
  }
  console.warn('[nativeBridge] 非 Native/iframe 环境，忽略调用:', message.type);
  return false;
}

/**
 * 请求 Native 端定位
 * @returns Promise<NativeGeolocationResult> 定位结果
 * @throws NativeGeolocationError 定位失败时抛出
 */
function requestGeolocation(): Promise<NativeGeolocationResult> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (messageHandler) {
        window.removeEventListener('message', messageHandler);
        messageHandler = null;
      }
    };

    // 监听 Native 端返回的定位结果
    messageHandler = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data.type === GEOLOCATION_SUCCESS && data.data) {
          cleanup();
          resolve(data.data as NativeGeolocationResult);
        } else if (data.type === GEOLOCATION_ERROR && data.data) {
          cleanup();
          reject(data.data as NativeGeolocationError);
        }
      } catch {
        // 忽略非 JSON 消息
      }
    };

    window.addEventListener('message', messageHandler);

    // 超时处理
    timeoutId = setTimeout(() => {
      cleanup();
      reject({ message: '定位超时', code: 'TIMEOUT' } as NativeGeolocationError);
    }, GEOLOCATION_TIMEOUT);

    // 发送定位请求
    const sent = send({ type: GEOLOCATION_REQUEST });
    if (!sent) {
      cleanup();
      reject({ message: '非 Native 环境，无法调用定位', code: 'NOT_NATIVE' } as NativeGeolocationError);
    }
  });
}

export const nativeBridge = {
  /** 请求 Native 端定位 */
  requestGeolocation,

  /** 是否运行在 Native WebView 中 */
  isNative: isNativeWebView,

  /** 是否运行在 iframe 中 */
  isIframe: isInIframe,
};

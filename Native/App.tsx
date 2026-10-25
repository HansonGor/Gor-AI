import React, { useRef, createElement } from 'react';
import { View, Platform } from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import {
  requestGeolocation,
  GEOLOCATION_REQUEST,
  GEOLOCATION_SUCCESS,
  GEOLOCATION_ERROR,
  GeolocationResult,
  GeolocationError,
} from '@/bridges/geolocation';

// ========== Web 页面地址 ==========
// Web 端用 localhost；真机 localhost 指向手机自身，要用电脑的局域网地址：
// 1. 显式配置 Native/.env.local 的 EXPO_PUBLIC_WEB_URL 优先（按 Expo 规则必须字面写 process.env.XXX 才会内联）；
// 2. 否则取手机连上的 Expo 开发服务器地址（expoConfig.hostUri，仅开发时存在），换成 Vite 端口 5173，
//    电脑 IP 被路由器重新分配也不用改配置。
const WEB_PORT = 5173;
function resolveWebUrl(): string {
  if (Platform.OS === 'web') return `http://localhost:${WEB_PORT}/`;
  if (process.env.EXPO_PUBLIC_WEB_URL) return process.env.EXPO_PUBLIC_WEB_URL;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || 'localhost'}:${WEB_PORT}/`;
}

// ========== App 入口 ==========
export default function App() {
  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

// ========== 主屏幕：全屏 WebView ==========
function MainScreen() {
  const insets = useSafeAreaInsets();
  // react-native-webview 14.0.1 的类型声明是 WebView<P = undefined>，props 为 WebViewProps & P，
  // 默认 P 会让 props 变成 never；显式传 {} 只修正类型，不影响运行时。
  const webViewRef = useRef<WebView<{}>>(null);

  const viteUrl = resolveWebUrl();

  /**
   * 处理 Web 端发来的消息
   * 当前支持：geolocation:request（请求定位）
   */
  const handleMessage = async (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      // 定位请求
      if (message.type === GEOLOCATION_REQUEST) {
        try {
          const result: GeolocationResult = await requestGeolocation();
          webViewRef.current?.postMessage(JSON.stringify({
            type: GEOLOCATION_SUCCESS,
            data: result,
          }));
        } catch (error) {
          const err = error as GeolocationError;
          webViewRef.current?.postMessage(JSON.stringify({
            type: GEOLOCATION_ERROR,
            data: { message: err.message || '定位失败', code: err.code },
          }));
        }
      }
    } catch {
      // 忽略非 JSON 消息
    }
  };

  return (
    // 注意：不能用 SafeAreaView edges={['top']}，会导致 iOS WKWebView 白屏
    // 用普通 View + paddingTop: insets.top 替代
    <View style={{ flex: 1, backgroundColor: '#000', paddingTop: insets.top }}>
      {Platform.OS === 'web' ? (
        // web 端用 iframe（react-native-webview 不支持 web 平台）
        createElement('iframe', {
          src: viteUrl,
          style: { flex: 1, width: '100%', border: 'none', backgroundColor: '#000' },
        } as React.IframeHTMLAttributes<HTMLIFrameElement>)
      ) : (
        <WebView<{}>
          ref={webViewRef}
          source={{ uri: viteUrl }}
          style={{ flex: 1, backgroundColor: '#000' }}
          onMessage={handleMessage}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          originWhitelist={['*']}
          mixedContentMode="always"
          bounces={false}
          overScrollMode="never"
          scrollEnabled={true}
        />
      )}
    </View>
  );
}

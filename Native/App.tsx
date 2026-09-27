import React, { useRef, createElement } from 'react';
import { View, Platform } from 'react-native';
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
  const webViewRef = useRef<WebView>(null);

  // Web 端用 localhost，真机用电脑局域网 IP（真机 localhost 指向手机自身）
  const viteUrl = Platform.OS === 'web'
    ? 'http://localhost:5173/'
    : 'http://192.168.1.4:5173/';

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
        <WebView
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

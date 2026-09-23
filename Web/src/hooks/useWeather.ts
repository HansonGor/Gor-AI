/**
 * 天气数据 Hook
 * 职责：
 * - Native WebView 环境：通过 nativeBridge 调用 Native 定位（expo-location）→ 高德 JSAPI 查询城市和天气
 * - 普通浏览器环境：高德 JSAPI 定位 → 高德 JSAPI 查询城市和天气
 * - 管理 loading / success / error 状态
 * 说明：城市和天气查询统一使用高德 JSAPI，不需要后端 Web 服务 Key
 */
import { useEffect, useState, useRef } from 'react';
import {
  loadAmap,
  getCurrentPosition,
  getCityInfoByCoords,
  getWeather,
  getWeatherIconKey,
} from '@/utils/amap';
import { nativeBridge } from '@/utils/nativeBridge';
import { AMAP_CONFIG } from '@/config';

export interface WeatherData {
  city: string;
  temperature: string;
  weather: string;
  iconKey: string;
}

export type WeatherStatus = 'loading' | 'success' | 'error';

export interface UseWeatherReturn {
  data: WeatherData | null;
  status: WeatherStatus;
  errorMessage: string;
  retry: () => void;
}

// 超时时间（毫秒）
const TIMEOUT_MS = 20000;

export function useWeather(): UseWeatherReturn {
  const [data, setData] = useState<WeatherData | null>(null);
  const [status, setStatus] = useState<WeatherStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const handleError = (msg: string) => {
    clearTimer();
    setStatus('error');
    setErrorMessage(msg);
  };

  const handleSuccess = (weatherData: WeatherData) => {
    clearTimer();
    setData(weatherData);
    setStatus('success');
    setErrorMessage('');
  };

  useEffect(() => {
    let isCancelled = false;

    const fetchWeather = async () => {
      setStatus('loading');
      setErrorMessage('');

      // 超时处理
      timeoutRef.current = setTimeout(() => {
        if (!isCancelled) {
          handleError('天气获取失败');
        }
      }, TIMEOUT_MS);

      try {
        // 1. 加载高德 JSAPI（用于 Geocoder 逆地理编码和 Weather 天气查询）
        await loadAmap(AMAP_CONFIG.JS_API_KEY, AMAP_CONFIG.JS_CODE);

        // 2. 定位：Native 环境用 Native 定位，普通浏览器用高德定位
        let latitude: number;
        let longitude: number;

        if (nativeBridge.isNative()) {
          // Native WebView 环境：通过桥接调用 expo-location
          const position = await nativeBridge.requestGeolocation();
          latitude = position.latitude;
          longitude = position.longitude;
        } else {
          // 普通浏览器环境：用高德 JSAPI Geolocation 定位
          const position = await getCurrentPosition();
          latitude = position.latitude;
          longitude = position.longitude;
        }

        // 3. 用高德 Geocoder 获取城市信息（英文城市名 + adcode，一次请求）
        const cityInfo = await getCityInfoByCoords(latitude, longitude);

        // 4. 用 adcode 查询实时天气（adcode 为空时用城市名）
        const weatherResult = await getWeather(cityInfo.adcode || cityInfo.city);

        if (!isCancelled) {
          handleSuccess({
            city: cityInfo.city,
            temperature: weatherResult.temperature,
            weather: weatherResult.weather,
            iconKey: getWeatherIconKey(weatherResult.weather),
          });
        }
      } catch (err: any) {
        if (!isCancelled) {
          handleError('天气获取失败');
        }
      }
    };

    fetchWeather();

    return () => {
      isCancelled = true;
      clearTimer();
    };
  }, [retryCount]);

  const retry = () => {
    setRetryCount((c) => c + 1);
  };

  return { data, status, errorMessage, retry };
}

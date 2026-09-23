/**
 * 高德地图 JSAPI 加载工具
 * 职责：动态加载高德 JSAPI 脚本，提供定位 + 天气查询能力
 * 说明：全部使用 JSAPI，不需要后端 Web 服务 Key
 */

// 高德 JSAPI 加载状态
import { pinyin } from 'pinyin-pro';

let amapLoadingPromise: Promise<void> | null = null;
let amapLoaded = false;

/**
 * 加载高德 JSAPI 脚本（含 Geolocation 和 Weather 插件）
 * @param jsApiKey 高德 JSAPI Key
 * @param jsCode 安全密钥（JSAPI 2.0 必需）
 */
export function loadAmap(jsApiKey: string, jsCode: string): Promise<void> {
  if (amapLoaded) return Promise.resolve();
  if (amapLoadingPromise) return amapLoadingPromise;

  amapLoadingPromise = new Promise((resolve, reject) => {
    // 设置安全密钥（必须在加载脚本之前）
    (window as any)._AMapSecurityConfig = {
      securityJsCode: jsCode,
    };

    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${jsApiKey}&plugin=AMap.Geolocation,AMap.Geocoder,AMap.Weather&language=en`;
    script.async = true;
    script.onload = () => {
      amapLoaded = true;
      amapLoadingPromise = null;
      resolve();
    };
    script.onerror = () => {
      amapLoadingPromise = null;
      reject(new Error('高德 JSAPI 加载失败'));
    };
    document.head.appendChild(script);
  });

  return amapLoadingPromise;
}

/**
 * 使用高德 JSAPI 获取当前位置经纬度（GCJ-02 坐标系）
 * 注意：高德 JSAPI 不支持返回英文城市名，英文城市名由 getEnglishCityName 单独获取
 * @returns Promise<{ latitude: number; longitude: number }>
 */
export function getCurrentPosition(): Promise<{ latitude: number; longitude: number }> {
  return new Promise((resolve, reject) => {
    const AMap = (window as any).AMap;
    if (!AMap) {
      reject(new Error('高德 JSAPI 未加载'));
      return;
    }

    const geolocation = new AMap.Geolocation({
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
      showButton: false,
      showMarker: false,
      showCircle: false,
    });

    geolocation.getCurrentPosition((status: string, result: any) => {
      if (status === 'complete') {
        resolve({
          latitude: result.position.lat,
          longitude: result.position.lng,
        });
      } else {
        reject(new Error(result.message || '定位失败'));
      }
    });
  });
}

/**
 * 将中文城市名转换为英文拼音
 * 例如：广州市 → Guangzhou，北京市 → Beijing
 * @param chineseCity 中文城市名（如"广州市"或"广州"）
 * @returns 英文拼音城市名
 */
export function cityToPinyin(chineseCity: string): string {
  if (!chineseCity) return 'Unknown';
  // 去掉"市"字
  const city = chineseCity.replace(/市$/, '');
  // 转拼音（不带声调，数组形式）
  const pinyinArr = pinyin(city, { toneType: 'none', type: 'array' });
  if (!pinyinArr || pinyinArr.length === 0) return chineseCity;
  // 拼接：第一个字首字母大写，其余字小写（如 Guangzhou，而非 GuangZhou）
  return pinyinArr
    .map((p: string, i: number) => {
      if (i === 0) return p.charAt(0).toUpperCase() + p.slice(1);
      return p;
    })
    .join('');
}

/**
 * 使用高德 JSAPI Geocoder 根据经纬度获取城市信息（英文城市名 + adcode）
 * @param lat 纬度
 * @param lng 经度
 * @returns Promise<{ city: string; adcode: string }>
 */
export function getCityInfoByCoords(lat: number, lng: number): Promise<{ city: string; adcode: string }> {
  return new Promise((resolve, reject) => {
    const AMap = (window as any).AMap;
    if (!AMap) {
      reject(new Error('高德 JSAPI 未加载'));
      return;
    }

    const geocoder = new AMap.Geocoder({
      radius: 1000,
      extensions: 'base',
    });

    geocoder.getAddress([lng, lat], (status: string, result: any) => {
      if (status === 'complete' && result.regeocode) {
        const comp = result.regeocode.addressComponent || {};
        const chineseCity = comp.city || comp.province || '';
        resolve({
          city: cityToPinyin(chineseCity),
          adcode: comp.adcode || '',
        });
      } else {
        reject(new Error('获取城市信息失败'));
      }
    });
  });
}

export interface WeatherResult {
  city: string;
  temperature: string;
  weather: string;
  windDirection: string;
  windPower: string;
  humidity: string;
  reportTime: string;
}

/**
 * 使用高德 JSAPI Weather 插件查询实时天气
 * @param adcodeOrCity 城市 adcode 或城市名
 * @returns Promise<WeatherResult>
 */
export function getWeather(adcodeOrCity: string): Promise<WeatherResult> {
  return new Promise((resolve, reject) => {
    const AMap = (window as any).AMap;
    if (!AMap) {
      reject(new Error('高德 JSAPI 未加载'));
      return;
    }

    const weather = new AMap.Weather();
    weather.getLive(adcodeOrCity, (err: any, data: any) => {
      if (err) {
        reject(new Error(err.message || '天气查询失败'));
        return;
      }
      resolve({
        city: data.city || '',
        temperature: data.temperature || '',
        weather: data.weather || '',
        windDirection: data.windDirection || '',
        windPower: data.windPower || '',
        humidity: data.humidity || '',
        reportTime: data.reportTime || '',
      });
    });
  });
}

/**
 * 天气状况 → emoji 图标映射
 */
const WEATHER_ICON_MAP: Record<string, string> = {
  '晴': '☀️',
  '少云': '🌤️',
  '晴间多云': '⛅',
  '多云': '⛅',
  '阴': '☁️',
  '阵雨': '🌦️',
  '雷阵雨': '⛈️',
  '小雨': '🌧️',
  '中雨': '🌧️',
  '大雨': '🌧️',
  '暴雨': '⛈️',
  '雨夹雪': '🌨️',
  '小雪': '❄️',
  '中雪': '❄️',
  '大雪': '❄️',
  '暴雪': '❄️',
  '雾': '🌫️',
  '霾': '🌫️',
  '浮尘': '🌫️',
  '扬沙': '🌫️',
  '沙尘暴': '🌪️',
};

export function getWeatherIcon(weather: string): string {
  return WEATHER_ICON_MAP[weather] || '🌡️';
}

/**
 * 天气状况 → lucide-react 图标 key 映射
 * 用于首页渲染 lucide 天气图标
 */
const WEATHER_ICON_KEY_MAP: Record<string, string> = {
  '晴': 'sun',
  '少云': 'cloud-sun',
  '晴间多云': 'cloud-sun',
  '多云': 'cloud',
  '阴': 'cloud',
  '阵雨': 'cloud-drizzle',
  '雷阵雨': 'cloud-lightning',
  '小雨': 'cloud-drizzle',
  '中雨': 'cloud-rain',
  '大雨': 'cloud-rain',
  '暴雨': 'cloud-lightning',
  '雨夹雪': 'cloud-snow',
  '小雪': 'cloud-snow',
  '中雪': 'cloud-snow',
  '大雪': 'cloud-snow',
  '暴雪': 'cloud-snow',
  '雾': 'cloud-fog',
  '霾': 'cloud-fog',
  '浮尘': 'cloud-fog',
  '扬沙': 'wind',
  '沙尘暴': 'wind',
  '有风': 'wind',
  '平静': 'wind',
  '微风': 'wind',
  '和风': 'wind',
  '清风': 'wind',
  '强风': 'wind',
  '疾风': 'wind',
  '大风': 'wind',
  '烈风': 'wind',
  '风暴': 'tornado',
  '狂爆风': 'tornado',
  '飓风': 'tornado',
  '热带风暴': 'tornado',
};

export function getWeatherIconKey(weather: string): string {
  return WEATHER_ICON_KEY_MAP[weather] || 'cloud';
}

/**
 * 检查是否在 Expo App WebView 环境中
 */
export function isExpoWebView(): boolean {
  return !!(window as any).ReactNativeWebView;
}

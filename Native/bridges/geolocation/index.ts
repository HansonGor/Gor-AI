/**
 * 定位模块
 * 使用 expo-location 获取设备当前位置
 *
 * 用法：
 *   import { requestGeolocation } from '@/modules/geolocation';
 *   const result = await requestGeolocation();
 */
import * as Location from 'expo-location';

// ========== 类型定义 ==========

/** 定位成功结果 */
export interface GeolocationResult {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: number;
}

/** 定位错误 */
export interface GeolocationError {
  message: string;
  code?: string;
}

/** Web → Native 定位请求消息 */
export interface GeolocationRequestMessage {
  type: 'geolocation:request';
}

/** Native → Web 定位成功消息 */
export interface GeolocationSuccessMessage {
  type: 'geolocation:success';
  data: GeolocationResult;
}

/** Native → Web 定位失败消息 */
export interface GeolocationErrorMessage {
  type: 'geolocation:error';
  data: GeolocationError;
}

/** 定位消息联合类型 */
export type GeolocationMessage =
  | GeolocationRequestMessage
  | GeolocationSuccessMessage
  | GeolocationErrorMessage;

/** 消息类型常量 */
export const GEOLOCATION_REQUEST = 'geolocation:request';
export const GEOLOCATION_SUCCESS = 'geolocation:success';
export const GEOLOCATION_ERROR = 'geolocation:error';

// ========== 方法实现 ==========

/**
 * 请求定位权限并获取当前位置
 * @returns Promise<GeolocationResult> 定位结果
 * @throws GeolocationError 定位失败时抛出
 */
export async function requestGeolocation(): Promise<GeolocationResult> {
  try {
    // 1. 请求定位权限
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      throw {
        message: '定位权限被拒绝，请在设置中允许定位权限',
        code: 'PERMISSION_DENIED',
      } as GeolocationError;
    }

    // 2. 获取当前位置
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    // 3. 转换为统一格式
    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      altitude: location.coords.altitude,
      heading: location.coords.heading,
      speed: location.coords.speed,
      timestamp: location.timestamp,
    };
  } catch (error: any) {
    // 统一错误格式
    if (error && error.message) {
      throw error as GeolocationError;
    }
    throw {
      message: error?.message || '定位失败',
      code: 'UNKNOWN_ERROR',
    } as GeolocationError;
  }
}

/**
 * 检查定位权限状态
 * @returns Promise<boolean> 是否已授权
 */
export async function hasGeolocationPermission(): Promise<boolean> {
  const { status } = await Location.getForegroundPermissionsAsync();
  return status === 'granted';
}

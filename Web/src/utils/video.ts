// 视频相关工具函数
import { VIDEO_CONFIG } from '../config';

/**
 * 从文本中提取视频链接
 */
export function extractVideoUrl(text: string): string | null {
  if (!text) return null;

  // 匹配 http/https 链接
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
  const urls = text.match(urlRegex);

  if (!urls || urls.length === 0) return null;

  for (const url of urls) {
    const cleanUrl = url.replace(/[.,;:!?]+$/, ''); // 去除末尾标点
    const lowerUrl = cleanUrl.toLowerCase();

    // 检查扩展名
    const hasVideoExt = VIDEO_CONFIG.EXTENSIONS.some((ext) => lowerUrl.endsWith(ext));
    // 检查域名
    const hasVideoDomain = VIDEO_CONFIG.DOMAINS.some((domain) => lowerUrl.includes(domain));

    if (hasVideoExt || hasVideoDomain) {
      return cleanUrl;
    }
  }

  return null;
}

/**
 * 从文本中移除视频链接（避免重复显示）
 * @param {string} text - 文本内容
 * @param {string} videoUrl - 要移除的视频链接
 * @returns {string} 移除后的文本
 */
export function removeVideoUrl(text: string, videoUrl: string): string {
  if (!text || !videoUrl) return text;
  return text.replace(videoUrl, '').trim();
}

/**
 * 构建视频代理 URL（通过后端代理访问，绕过浏览器 403/Referer 限制）
 * @param {string} videoUrl - 原始视频链接
 * @returns {string} 代理后的 URL
 */
export function buildProxyVideoUrl(videoUrl: string | null | undefined): string | null {
  if (!videoUrl) return null;
  return `/api/video/proxy?url=${encodeURIComponent(videoUrl)}`;
}

export default {
  extractVideoUrl,
  removeVideoUrl,
  buildProxyVideoUrl,
};

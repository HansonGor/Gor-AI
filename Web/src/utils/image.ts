// 图片压缩工具
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1600;
const QUALITY = 0.8;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * 压缩图片并返回 base64 data URL
 */
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    // 小图直接转 base64
    if (file.size <= MAX_FILE_SIZE) {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
      return;
    }

    // 大图用 Canvas 压缩
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        // 等比缩放
        if (width > MAX_WIDTH || height > MAX_HEIGHT) {
          const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 上下文获取失败'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);

        // 输出 JPEG 格式（压缩率高）
        const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const dataUrl = canvas.toDataURL(mimeType, QUALITY);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 批量压缩图片
 */
export async function compressImages(
  files: FileList | File[]
): Promise<Array<{ base64: string; name: string; file: File }>> {
  const fileArray = Array.from(files);
  const results: Array<{ base64: string; name: string; file: File }> = [];

  for (const file of fileArray) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const base64 = await compressImage(file);
      results.push({ base64, name: file.name, file });
    } catch (err) {
      console.error('图片压缩失败:', err);
    }
  }

  return results;
}

export default compressImage;

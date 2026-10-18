export function appendMessageErrorOnce(content: string, message: string | undefined, fallback: string): string {
  const suffix = `\n\n错误：${message || fallback}`;
  return content.endsWith(suffix) ? content : `${content}${suffix}`;
}

/** File counts in the shared project copy; no change to stored numeric values. */
export function chineseCount(count: number): string {
  if (!Number.isSafeInteger(count) || count < 0 || count > 9999) return String(count);
  if (count === 0) return '零';
  const digits = '零一二三四五六七八九';
  const units = ['', '十', '百', '千'];
  let result = '';
  let gap = false;
  for (let place = 3; place >= 0; place--) {
    const digit = Math.floor(count / 10 ** place) % 10;
    if (digit) {
      if (gap) result += '零';
      result += digits[digit] + units[place];
      gap = false;
    } else if (result) gap = true;
  }
  return result.replace(/^一十/, '十');
}

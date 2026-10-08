/** Parse declarations only; never execute HTML/CDN scripts in the host app. */
export function htmlAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
}

export function htmlScripts(html: string) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  return Array.from(source.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi), (match) => ({
    tag: match[1], source: match[2], type: htmlAttribute(match[1], 'type')?.toLowerCase(),
    src: htmlAttribute(match[1], 'src'),
  }));
}

export const BABEL_PREVIEW_ENTRY = '/__gor_babel_entry__.jsx';
export function hasBabelScripts(html: string): boolean {
  return htmlScripts(html).some((script) => script.type === 'text/babel' || script.type === 'text/jsx');
}

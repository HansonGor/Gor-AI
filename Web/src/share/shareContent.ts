import type { ChatMessage } from '../types';

/** Deliberately narrow DTO: execution/project/source objects cannot reach the template. */
export interface ShareMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images: string[];
  citationNames: Record<string, string>;
}
export function isShareableMessage(message: ChatMessage): boolean {
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    !message.isStreaming &&
    Boolean(message.content.trim() || message.images?.some((image) => image.trim()))
  );
}
export function extractShareMessages(
  messages: ChatMessage[],
  selectedIds: ReadonlySet<string>,
): ShareMessage[] {
  const seen = new Set<string>();
  return messages
    .filter(
      (message) =>
        selectedIds.has(message.id) &&
        isShareableMessage(message) &&
        !seen.has(message.id) &&
        Boolean(seen.add(message.id)),
    )
    .map(({ id, role, content, images, searchSources }) => ({
      id,
      role,
      content,
      images: [...(images ?? []).filter((image) => image.trim())],
      citationNames: Object.fromEntries(
        (searchSources ?? []).map((source) => [
          source.sourceId,
          source.title || source.source || source.domain || '来源',
        ]),
      ),
    }));
}

// A remark transform touches prose text only, never fenced/inline code, images or links.
// Replace citation-only runtime IDs with a readable title when known, otherwise remove the ID.
interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}
export function shareCitations(names: Record<string, string> = {}) {
  return () => (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode, literal = false) => {
      const skip =
        literal || ['code', 'inlineCode', 'image', 'link', 'linkReference'].includes(node.type);
      if (!skip && node.type === 'text' && node.value)
        node.value = node.value.replace(/\[S(\d+)\]/g, (_, id: string) => {
          const name = Object.prototype.hasOwnProperty.call(names, `S${id}`)
            ? names[`S${id}`]
            : undefined;
          return name ? `（${name}）` : '';
        });
      node.children?.forEach((child) => visit(child, skip));
    };
    visit(tree);
  };
}

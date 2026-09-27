import type { ChatMessage, GeneratedFile, ProjectChange } from '../../types.ts';

function isHtmlArtifact(file: GeneratedFile): boolean {
  return file.fileType === 'html' || /\.html?$/i.test(file.displayName);
}

function projectChangeUrl(path: string): string {
  return `/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** HTML entry files belonging to a message-scoped project are represented by its project snapshot. */
export function getSnapshotBackedHtmlArtifactUrls(
  messages: ChatMessage[],
  projectChanges: ProjectChange[] = [],
): Set<string> {
  const urls = new Set<string>();
  const hasProjectSnapshot = messages.some((message) => Boolean(message.previewSnapshot));
  for (const message of messages) {
    if (!message.previewSnapshot) continue;
    const files = message.files?.length ? message.files : message.file ? [message.file] : [];
    files.filter(isHtmlArtifact).forEach((file) => urls.add(file.downloadUrl));
    message.projectChanges?.forEach((change) => {
      if (/\.html?$/i.test(change.path)) urls.add(projectChangeUrl(change.path));
    });
  }
  // A project-change HTML entry is an implementation file, not a second deliverable,
  // when the conversation already has a message-scoped project snapshot. Do not infer
  // this from the template: restored React projects can be normalized as `html`.
  if (hasProjectSnapshot) {
    projectChanges.forEach((change) => {
      if (/\.html?$/i.test(change.path)) urls.add(projectChangeUrl(change.path));
    });
  }
  return urls;
}

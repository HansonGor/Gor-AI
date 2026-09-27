export interface SaveFileOptions {
  suggestedName: string;
  blob: Blob;
}

interface WritableFileHandle {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<WritableFileHandle>;
}

/** Save through the native file picker when available, with a browser-download fallback. */
export async function saveBlob({ suggestedName, blob }: SaveFileOptions): Promise<boolean> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker && window.isSecureContext) {
    try {
      const handle = await picker({ suggestedName });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      throw error;
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = suggestedName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return true;
}

/** Reserve the destination during the click gesture, then create and write a Blob asynchronously. */
export async function saveBlobTask(
  suggestedName: string,
  createBlob: () => Promise<Blob>,
): Promise<boolean> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker && window.isSecureContext) {
    let handle: WritableFileHandle;
    try {
      handle = await picker({ suggestedName });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      throw error;
    }
    const blob = await createBlob();
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  }
  return saveBlob({ suggestedName, blob: await createBlob() });
}

/** Fetch a generated artifact before opening Save As, so the file picker receives a Blob. */
export async function saveUrl(url: string, suggestedName: string): Promise<boolean> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker || !window.isSecureContext) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = suggestedName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  let handle: WritableFileHandle;
  try {
    // Open the picker directly from the click gesture before awaiting the fetch.
    handle = await picker({ suggestedName });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    throw error;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const writable = await handle.createWritable();
  await writable.write(await response.blob());
  await writable.close();
  return true;
}

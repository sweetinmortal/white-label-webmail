export interface SelectedFileLike {
  size: number;
}

export interface DraggedItemLike {
  kind: string;
  webkitGetAsEntry?: () => { isDirectory: boolean } | null;
}

export function isFileDrag(types: Iterable<string> | null | undefined): boolean {
  return Boolean(types && Array.from(types).includes('Files'));
}

export function containsDirectory(items: Iterable<DraggedItemLike> | null | undefined): boolean {
  if (!items) return false;
  return Array.from(items).some((item) => {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') return false;
    return Boolean(item.webkitGetAsEntry()?.isDirectory);
  });
}

export function attachmentSelectionError(
  selected: readonly SelectedFileLike[],
  currentCount: number,
  currentBytes: number,
  maxFiles: number,
  maxBytes: number,
  formatBytes: (bytes: number) => string,
): string | null {
  if (!selected.length) return null;
  if (currentCount + selected.length > maxFiles) {
    return `Puedes adjuntar como máximo ${maxFiles} archivos.`;
  }
  const incomingBytes = selected.reduce((total, file) => total + file.size, 0);
  if (currentBytes + incomingBytes > maxBytes) {
    return `Los adjuntos superan el límite de ${formatBytes(maxBytes)} en total.`;
  }
  if (selected.some((file) => file.size === 0)) {
    return 'Uno de los archivos está vacío.';
  }
  return null;
}

import { describe, expect, it } from 'vitest';
import { attachmentSelectionError, containsDirectory, isFileDrag } from '../ui/lib/attachment-selection';

const format = (bytes: number) => `${bytes} B`;

describe('attachment selection validation', () => {
  it('allows one or several files within the combined limits', () => {
    expect(attachmentSelectionError([{ size: 1 }, { size: 2 }], 0, 0, 5, 10, format)).toBeNull();
    expect(attachmentSelectionError([{ size: 2 }], 4, 8, 5, 10, format)).toBeNull();
  });

  it('rejects selections that exceed the file count or combined size', () => {
    expect(attachmentSelectionError([{ size: 1 }, { size: 1 }], 4, 2, 5, 10, format)).toContain('5 archivos');
    expect(attachmentSelectionError([{ size: 5 }], 1, 6, 5, 10, format)).toContain('10 B');
  });

  it('rejects empty files and ignores an empty selection', () => {
    expect(attachmentSelectionError([], 0, 0, 5, 10, format)).toBeNull();
    expect(attachmentSelectionError([{ size: 1 }, { size: 0 }], 0, 0, 5, 10, format)).toContain('vacío');
  });

  it('only captures file drags and rejects folder entries', () => {
    expect(isFileDrag(['text/plain'])).toBe(false);
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(undefined)).toBe(false);
    expect(containsDirectory([{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }])).toBe(false);
    expect(containsDirectory([{ kind: 'string' }, { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }])).toBe(true);
  });
});

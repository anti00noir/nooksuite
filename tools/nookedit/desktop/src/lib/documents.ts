import type { DocumentRecord } from './api';

export type DocumentKind = 'markdown' | 'text' | 'pdf' | 'image' | 'other';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'text',
  'log',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'htm',
  'yaml',
  'yml',
  'ini',
  'cfg',
  'conf',
  'toml',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'rs',
  'py',
  'sh',
  'bat',
  'ps1',
]);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > -1 && dot < name.length - 1
    ? name.slice(dot + 1).toLocaleLowerCase()
    : '';
}

export function documentKind(record: DocumentRecord): DocumentKind {
  const extension = extensionOf(record.name);

  if (extension === 'pdf' || record.mediaType === 'application/pdf') return 'pdf';
  if (
    MARKDOWN_EXTENSIONS.has(extension) ||
    record.mediaType === 'text/markdown'
  ) {
    return 'markdown';
  }
  if (record.mediaType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }
  if (
    record.mediaType.startsWith('text/') ||
    record.mediaType === 'application/json' ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    return 'text';
  }

  return 'other';
}

export function isTextKind(
  kind: DocumentKind,
): kind is 'text' | 'markdown' {
  return kind === 'text' || kind === 'markdown';
}

export function kindLabel(kind: DocumentKind): string {
  switch (kind) {
    case 'markdown':
      return 'Markdown';
    case 'text':
      return 'Text';
    case 'pdf':
      return 'PDF';
    case 'image':
      return 'Image';
    default:
      return 'File';
  }
}

export function exportFilters(
  kind: DocumentKind,
): { name: string; extensions: string[] }[] {
  switch (kind) {
    case 'pdf':
      return [{ name: 'PDF', extensions: ['pdf'] }];
    case 'markdown':
      return [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'Plain text', extensions: ['txt'] },
      ];
    case 'text':
      return [
        { name: 'Plain text', extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
      ];
    case 'image':
      return [
        {
          name: 'Image',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'],
        },
      ];
    default:
      return [{ name: 'All files', extensions: ['*'] }];
  }
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

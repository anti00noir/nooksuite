import type { DocumentRecord } from './api';

const EXTENSION_BADGES: Record<string, string> = {
  pdf: 'PDF',
  doc: 'DOC',
  docx: 'DOC',
  xls: 'XLS',
  xlsx: 'XLS',
  csv: 'CSV',
  ppt: 'PPT',
  pptx: 'PPT',
  png: 'IMG',
  jpg: 'IMG',
  jpeg: 'IMG',
  gif: 'IMG',
  webp: 'IMG',
  svg: 'IMG',
  avif: 'IMG',
  bmp: 'IMG',
  txt: 'TXT',
  md: 'MD',
  json: 'JSON',
  zip: 'ZIP',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > -1 && dot < name.length - 1
    ? name.slice(dot + 1).toLocaleLowerCase()
    : '';
}

export function badgeFor(record: DocumentRecord): string {
  const extension = extensionOf(record.name);
  if (extension) {
    if (EXTENSION_BADGES[extension]) return EXTENSION_BADGES[extension];
    if (extension.length <= 4) return extension.toLocaleUpperCase();
  }

  if (record.mediaType.startsWith('image/')) return 'IMG';
  if (record.mediaType === 'application/pdf') return 'PDF';
  if (record.mediaType.startsWith('text/')) return 'TXT';
  return 'FILE';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

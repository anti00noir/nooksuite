import { invoke } from '@tauri-apps/api/core';

export type DocumentRecord = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type LibrarySnapshot = {
  root: string;
  libraryId: string;
  records: DocumentRecord[];
};

export type ImportOutcome = {
  library: LibrarySnapshot;
  imported: DocumentRecord[];
  errors: string[];
};

export type Settings = {
  libraryPath?: string | null;
};

export type HeadlessConfig = {
  reportPath: string;
  libraryRoot: string | null;
  pdfPath: string | null;
};

export const api = {
  loadSettings: () => invoke<Settings>('load_settings'),
  saveSettings: (settings: Settings) => invoke<void>('save_settings', { settings }),
  defaultLibraryPath: () => invoke<string>('default_library_path'),
  openLibrary: (path: string) => invoke<LibrarySnapshot>('open_library', { path }),
  importDocuments: (root: string, paths: string[]) =>
    invoke<ImportOutcome>('import_documents', { root, paths }),
  renameDocument: (root: string, id: string, name: string) =>
    invoke<LibrarySnapshot>('rename_document', { root, id, name }),
  removeDocument: (root: string, id: string) =>
    invoke<LibrarySnapshot>('remove_document', { root, id }),
  readDocumentText: (root: string, id: string) =>
    invoke<string>('read_document_text', { root, id }),
  readDocumentBytes: (root: string, id: string) =>
    invoke<ArrayBuffer>('read_document_bytes', { root, id }),
  saveDocument: (root: string, id: string, text: string) =>
    invoke<DocumentRecord>('save_document', { root, id, text }),
  exportDocument: (
    root: string,
    id: string,
    destination: string,
    text: string | null,
  ) => invoke<void>('export_document', { root, id, destination, text }),
};

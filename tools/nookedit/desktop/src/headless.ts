import { invoke } from '@tauri-apps/api/core';

import { api, type HeadlessConfig } from './lib/api';
import { describeError } from './lib/errors';

type LibraryReport = {
  root: string;
  importedId: string;
  reopenedText: string;
};

// Runs the benchmark and library check inside a real Tauri/WebView2 window,
// writes the report, and exits. scripts/run-headless.mjs watches for the file.
export async function runHeadless(config: HeadlessConfig) {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  try {
    const { runPdfBenchmark } = await import('./pdf-benchmark');
    report.pdf = await runPdfBenchmark('/fixtures/100-pages.pdf');
  } catch (error) {
    report.pdfError = describeError(error);
  }

  if (config.libraryRoot) {
    try {
      report.library = await invoke('headless_library_check', {
        root: config.libraryRoot,
      });
    } catch (error) {
      report.libraryError = describeError(error);
    }
  }

  const library = report.library as LibraryReport | undefined;

  // Exercise the same IPC wrappers the UI uses: text, raw bytes, and a save.
  if (library) {
    try {
      const text = await api.readDocumentText(library.root, library.importedId);
      const bytes = await api.readDocumentBytes(library.root, library.importedId);
      const saved = await api.saveDocument(
        library.root,
        library.importedId,
        'saved over ipc\n',
      );
      const after = await api.readDocumentText(library.root, library.importedId);

      report.ipc = {
        readMatches: text === library.reopenedText,
        isArrayBuffer: bytes instanceof ArrayBuffer,
        byteLength: bytes.byteLength,
        savedSize: saved.size,
        saveMatches: after === 'saved over ipc\n',
      };
    } catch (error) {
      report.ipcError = describeError(error);
    }
  }

  // Import the fixture through the UI's command, read it back as raw bytes,
  // and render page one with the same pdf.js build the viewer uses.
  if (config.pdfPath && config.libraryRoot) {
    try {
      const outcome = await api.importDocuments(config.libraryRoot, [
        config.pdfPath,
      ]);
      const record = outcome.imported[0];
      if (!record) {
        throw new Error(outcome.errors[0] ?? 'The PDF fixture was not imported.');
      }

      const bytes = await api.readDocumentBytes(config.libraryRoot, record.id);
      const byteLength = bytes.byteLength;
      const { pdfjs } = await import('./lib/pdf');
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;

      report.pdfViewer = {
        name: record.name,
        pages: pdf.numPages,
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        byteLength,
        rendered: true,
      };

      await loadingTask.destroy();
    } catch (error) {
      report.pdfViewerError = describeError(error);
    }
  }

  report.finishedAt = new Date().toISOString();
  await invoke('save_report', {
    path: config.reportPath,
    body: JSON.stringify(report, null, 2),
  });
  await invoke('quit_app');
}

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
      // pdf.js transfers the buffer to its worker, so give it a copy and keep
      // the original for the page-operation check below.
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(bytes).slice(),
      });
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

      // Exercise the same reducer, pdf-lib rewrite, and binary save the UI
      // uses: rotate, duplicate, move, delete, then undo the delete.
      try {
        const { buildPdfBytes, identityPlan, planReducer } = await import(
          './lib/pdf-pages'
        );

        let state = {
          plan: identityPlan(pdf.numPages).slice(0, 3),
          history: [] as ReturnType<typeof identityPlan>[],
        };
        state = planReducer(state, { type: 'rotate', index: 0, delta: 90 });
        state = planReducer(state, { type: 'duplicate', index: 0 });
        state = planReducer(state, {
          type: 'move',
          index: 1,
          delta: state.plan.length - 2,
        });
        state = planReducer(state, { type: 'remove', index: 1 });
        const pagesAfterRemove = state.plan.length;
        state = planReducer(state, { type: 'undo' });
        const pagesAfterUndo = state.plan.length;

        const plannedBytes = await buildPdfBytes(
          bytes,
          state.plan,
          pdf.numPages,
        );
        const savedRecord = await api.saveDocumentBytes(
          config.libraryRoot,
          record.id,
          plannedBytes,
        );
        const savedBytes = await api.readDocumentBytes(
          config.libraryRoot,
          record.id,
        );

        const savedTask = pdfjs.getDocument({
          data: new Uint8Array(savedBytes).slice(),
        });
        const savedPdf = await savedTask.promise;
        const rotations: number[] = [];
        for (let number = 1; number <= savedPdf.numPages; number += 1) {
          rotations.push((await savedPdf.getPage(number)).rotate);
        }

        report.pdfPageOps = {
          plannedPages: state.plan.length,
          pagesAfterRemove,
          pagesAfterUndo,
          undone: pagesAfterUndo === pagesAfterRemove + 1,
          savedPages: savedPdf.numPages,
          rotations,
          plannedBytes: plannedBytes.byteLength,
          savedBytes: savedBytes.byteLength,
          recordSize: savedRecord.size,
          sizesMatch:
            savedRecord.size === plannedBytes.byteLength &&
            savedBytes.byteLength === plannedBytes.byteLength,
          orderMatches:
            savedPdf.numPages === 4 &&
            rotations[0] === 90 &&
            rotations[1] === 0 &&
            rotations[2] === 0 &&
            rotations[3] === 90,
        };

        await savedTask.destroy();
      } catch (error) {
        report.pdfPageOpsError = describeError(error);
      }

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

import { invoke } from '@tauri-apps/api/core';

import type { HeadlessConfig } from './lib/api';
import { describeError } from './lib/errors';
import { runPdfBenchmark } from './pdf-benchmark';

// Runs the benchmark and library check inside a real Tauri/WebView2 window,
// writes the report, and exits. scripts/run-headless.mjs watches for the file.
export async function runHeadless(config: HeadlessConfig) {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  try {
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

  report.finishedAt = new Date().toISOString();
  await invoke('save_report', {
    path: config.reportPath,
    body: JSON.stringify(report, null, 2),
  });
  await invoke('quit_app');
}

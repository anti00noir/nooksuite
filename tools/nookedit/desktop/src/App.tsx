import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { runPdfBenchmark, type PdfBenchmarkResult } from './pdf-benchmark';

type FsSpikeReport = {
  root: string;
  libraryJson: string;
  documentPath: string;
  documentText: string;
  atomicWrite: boolean;
  hiddenDir: boolean;
  nestedDirs: boolean;
};

function describeError(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export default function App() {
  const [fsReport, setFsReport] = useState<FsSpikeReport | null>(null);
  const [fsError, setFsError] = useState<string | null>(null);
  const [fsBusy, setFsBusy] = useState(false);

  const [pdfResult, setPdfResult] = useState<PdfBenchmarkResult | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  async function runFsSpike() {
    setFsBusy(true);
    setFsError(null);
    setFsReport(null);

    try {
      const root = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder for the NookEdit library',
      });

      if (!root) {
        setFsError('No folder selected.');
        return;
      }

      const report = await invoke<FsSpikeReport>('run_fs_spike', { root });
      setFsReport(report);
    } catch (error) {
      setFsError(describeError(error));
    } finally {
      setFsBusy(false);
    }
  }

  async function runPdf() {
    setPdfBusy(true);
    setPdfError(null);
    setPdfResult(null);

    try {
      setPdfResult(await runPdfBenchmark('/fixtures/100-pages.pdf'));
    } catch (error) {
      setPdfError(describeError(error));
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>NookEdit — P0 spikes</h1>
        <p>Throwaway harnesses for the Phase 0 go/no-go checks.</p>
      </header>

      <section className="card">
        <h2>Tauri filesystem spike</h2>
        <p>
          Pick a folder, then create <code>.nooksuite/library.json</code> and a nested{' '}
          <code>documents/&lt;id&gt;/hello.txt</code>.
        </p>
        <button type="button" onClick={runFsSpike} disabled={fsBusy}>
          {fsBusy ? 'Running…' : 'Pick folder and run'}
        </button>
        {fsError && <p className="error">{fsError}</p>}
        {fsReport && (
          <dl className="report">
            <dt>Root</dt>
            <dd>{fsReport.root}</dd>
            <dt>Hidden dir</dt>
            <dd>{String(fsReport.hiddenDir)}</dd>
            <dt>Nested dirs</dt>
            <dd>{String(fsReport.nestedDirs)}</dd>
            <dt>Atomic write</dt>
            <dd>{String(fsReport.atomicWrite)}</dd>
            <dt>library.json</dt>
            <dd>{fsReport.libraryJson}</dd>
            <dt>Document</dt>
            <dd>{fsReport.documentPath}</dd>
            <dt>Read back</dt>
            <dd>{fsReport.documentText.trim()}</dd>
          </dl>
        )}
      </section>

      <section className="card">
        <h2>pdf.js benchmark</h2>
        <p>
          Renders all pages of <code>public/fixtures/100-pages.pdf</code> to canvases and reports
          timing.
        </p>
        <button type="button" onClick={runPdf} disabled={pdfBusy}>
          {pdfBusy ? 'Rendering…' : 'Run PDF benchmark'}
        </button>
        {pdfError && <p className="error">{pdfError}</p>}
        {pdfResult && (
          <dl className="report">
            <dt>Pages</dt>
            <dd>{pdfResult.pages}</dd>
            <dt>First page</dt>
            <dd>{pdfResult.firstPageMs.toFixed(0)} ms</dd>
            <dt>Total</dt>
            <dd>{pdfResult.totalMs.toFixed(0)} ms</dd>
            <dt>Per page</dt>
            <dd>{pdfResult.msPerPage.toFixed(1)} ms</dd>
            <dt>Pages/sec</dt>
            <dd>{pdfResult.pagesPerSecond.toFixed(1)}</dd>
            <dt>JS heap</dt>
            <dd>{pdfResult.heapMb == null ? 'n/a' : `${pdfResult.heapMb.toFixed(1)} MB`}</dd>
          </dl>
        )}
      </section>

      <footer className="app-footer">
        <p>
          In a plain browser the Tauri spike fails with “not in a Tauri window” — expected. Run{' '}
          <code>npm run tauri dev</code> after installing Rust + MSVC to test it for real.
        </p>
      </footer>
    </main>
  );
}

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfBenchmarkResult = {
  pages: number;
  firstPageMs: number;
  totalMs: number;
  msPerPage: number;
  pagesPerSecond: number;
  heapMb: number | null;
};

export async function runPdfBenchmark(url: string): Promise<PdfBenchmarkResult> {
  const loadingTask = pdfjs.getDocument({ url });
  const pdf = await loadingTask.promise;
  const pages = pdf.numPages;

  const canvas = document.createElement('canvas');
  if (!canvas.getContext('2d', { alpha: false })) {
    throw new Error('Could not create a 2D canvas context.');
  }

  const start = performance.now();
  let firstPageMs = 0;

  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    page.cleanup();

    if (pageNumber === 1) firstPageMs = performance.now() - start;
  }
  const totalMs = performance.now() - start;

  await loadingTask.destroy();

  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const heapMb = memory ? memory.usedJSHeapSize / (1024 * 1024) : null;

  return {
    pages,
    firstPageMs,
    totalMs,
    msPerPage: totalMs / pages,
    pagesPerSecond: (pages / totalMs) * 1000,
    heapMb,
  };
}

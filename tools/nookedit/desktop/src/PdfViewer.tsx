import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

import { api, type DocumentRecord } from './lib/api';
import { describeError } from './lib/errors';
import { pdfjs } from './lib/pdf';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
// ResizeObserver reports the content box, which already excludes the scroll
// container's padding. Only a small safety gap is needed.
const PAGE_PADDING = 2;

type Props = {
  root: string;
  record: DocumentRecord;
  onError: (message: string | null) => void;
};

export function PdfViewer({ root, record, onError }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [fit, setFit] = useState<'width' | 'page' | 'none'>('width');
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;

    setLoading(true);
    setPdf(null);
    setPage(null);

    void (async () => {
      const buffer = await api.readDocumentBytes(root, record.id);
      if (cancelled) return;

      task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
      const document = await task.promise;
      if (cancelled) return;

      setPdf(document);
      setPageNumber(1);
      setPageDraft('1');
    })().catch((cause) => {
      if (cancelled) return;
      setLoading(false);
      onError(describeError(cause));
    });

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [root, record.id, onError]);

  useEffect(() => {
    if (!pdf) return;

    let cancelled = false;

    void pdf
      .getPage(pageNumber)
      .then((next) => {
        if (cancelled) return;
        const viewport = next.getViewport({ scale: 1 });
        setBaseSize({ width: viewport.width, height: viewport.height });
        setPage(next);
        setLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setLoading(false);
        onError(describeError(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, onError]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (!baseSize) return 1;

    const availableWidth = Math.max(size.width - PAGE_PADDING * 2, 160);
    const availableHeight = Math.max(size.height - PAGE_PADDING * 2, 160);
    const widthScale = availableWidth / baseSize.width;
    const heightScale = availableHeight / baseSize.height;

    const raw =
      fit === 'width'
        ? widthScale
        : fit === 'page'
          ? Math.min(widthScale, heightScale)
          : zoom;

    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
  }, [baseSize, size, fit, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!page || !canvas) return;

    let cancelled = false;
    let task: RenderTask | null = null;

    const viewport = page.getViewport({ scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);

    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    });

    task.promise.catch((cause: unknown) => {
      if (cancelled) return;
      const name = (cause as { name?: string } | null)?.name;
      if (name === 'RenderingCancelledException') return;
      onError(describeError(cause));
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [page, scale, onError]);

  function goTo(next: number) {
    if (!pdf) return;

    const clamped = Math.min(pdf.numPages, Math.max(1, Math.round(next)));
    setPageNumber(clamped);
    setPageDraft(String(clamped));
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        goTo(pageNumber + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        goTo(pageNumber - 1);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pageNumber, pdf]);

  function zoomBy(factor: number) {
    setFit('none');
    setZoom(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor)));
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="pdf-group">
          <button
            type="button"
            className="ghost"
            onClick={() => goTo(pageNumber - 1)}
            disabled={pageNumber <= 1}
            aria-label="Previous page"
          >
            ‹
          </button>
          <form
            className="page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              goTo(Number(pageDraft) || pageNumber);
            }}
          >
            <input
              value={pageDraft}
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={() => setPageDraft(String(pageNumber))}
              aria-label="Page number"
              inputMode="numeric"
            />
            <span>of {pdf?.numPages ?? '…'}</span>
          </form>
          <button
            type="button"
            className="ghost"
            onClick={() => goTo(pageNumber + 1)}
            disabled={!pdf || pageNumber >= pdf.numPages}
            aria-label="Next page"
          >
            ›
          </button>
        </div>

        <div className="pdf-group">
          <button type="button" className="ghost" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
            −
          </button>
          <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" className="ghost" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
            +
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setFit('width')}
            aria-pressed={fit === 'width'}
          >
            Fit width
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setFit('page')}
            aria-pressed={fit === 'page'}
          >
            Fit page
          </button>
        </div>
      </div>

      <div className="pdf-scroll" ref={containerRef}>
        <canvas ref={canvasRef} className="pdf-canvas" />
        {loading && <p className="pdf-loading">Loading PDF…</p>}
      </div>
    </div>
  );
}

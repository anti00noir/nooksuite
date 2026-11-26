import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { Ref } from 'react';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

import { api, type DocumentRecord } from './lib/api';
import { describeError } from './lib/errors';
import { pdfjs } from './lib/pdf';
import {
  buildPdfBytes,
  isIdentityPlan,
  pageRotation,
  planReducer,
  type PageEntry,
} from './lib/pdf-pages';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
// ResizeObserver reports the content box, which already excludes the scroll
// container's padding. Only a small safety gap is needed.
const PAGE_PADDING = 2;
const THUMB_MAX_WIDTH = 132;
const THUMB_MAX_HEIGHT = 176;

export type PdfViewerHandle = {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  buildBytes: () => Promise<Uint8Array>;
};

type Props = {
  root: string;
  record: DocumentRecord;
  onError: (message: string | null) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRecordUpdated: (record: DocumentRecord) => void;
  ref?: Ref<PdfViewerHandle>;
};

export function PdfViewer({
  root,
  record,
  onError,
  onDirtyChange,
  onRecordUpdated,
  ref,
}: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [active, setActive] = useState<{
    page: PDFPageProxy;
    rotation: number;
  } | null>(null);
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [planState, dispatch] = useReducer(planReducer, {
    plan: [],
    history: [],
  });
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [fit, setFit] = useState<'width' | 'page' | 'none'>('width');
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'single' | 'grid'>('single');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sourcePageCount, setSourcePageCount] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<Uint8Array | null>(null);
  const savingRef = useRef(false);

  const plan = planState.plan;
  const dirty = !isIdentityPlan(plan, sourcePageCount);
  const pageCount = plan.length;
  const entry = plan[pageNumber - 1];

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;

    setLoading(true);
    setPdf(null);
    setActive(null);
    setBaseSize(null);
    setPageNumber(1);
    setPageDraft('1');

    void (async () => {
      const buffer = await api.readDocumentBytes(root, record.id);
      if (cancelled) return;

      const bytes = new Uint8Array(buffer);
      sourceRef.current = bytes;

      // pdf.js transfers the buffer it is given to its worker. Hand it a copy
      // so the original stays available for pdf-lib when the user saves.
      task = pdfjs.getDocument({ data: bytes.slice() });
      const document = await task.promise;
      if (cancelled) return;

      setSourcePageCount(document.numPages);
      setPdf(document);
      dispatch({ type: 'reset', pageCount: document.numPages });
    })().catch((cause) => {
      if (cancelled) return;
      setLoading(false);
      onError(describeError(cause));
    });

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [root, record.id, version, onError]);

  useEffect(() => {
    if (!pdf || !entry) return;

    let cancelled = false;

    void pdf
      .getPage(entry.source + 1)
      .then((next) => {
        if (cancelled) return;
        const rotation = pageRotation(next, entry);
        const viewport = next.getViewport({ scale: 1, rotation });
        setBaseSize({ width: viewport.width, height: viewport.height });
        setActive({ page: next, rotation });
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
  }, [pdf, entry?.source, entry?.rotation, onError]);

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

  useEffect(() => {
    if (pageCount === 0 || pageNumber <= pageCount) return;
    setPageNumber(pageCount);
    setPageDraft(String(pageCount));
  }, [pageCount, pageNumber]);

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
    if (!active || !canvas || mode !== 'single') return;

    let cancelled = false;
    let task: RenderTask | null = null;

    const viewport = active.page.getViewport({
      scale,
      rotation: active.rotation,
    });
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);

    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    task = active.page.render({
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
  }, [active, scale, mode, onError]);

  const buildBytes = useCallback(async () => {
    const source = sourceRef.current;
    if (!source) throw new Error('The PDF is still loading.');
    return buildPdfBytes(source, plan, sourcePageCount);
  }, [plan, sourcePageCount]);

  const save = useCallback(async () => {
    if (savingRef.current || isIdentityPlan(plan, sourcePageCount)) return false;

    const source = sourceRef.current;
    if (!source) return false;

    savingRef.current = true;
    setBusy(true);

    try {
      const bytes = await buildPdfBytes(source, plan, sourcePageCount);
      const updated = await api.saveDocumentBytes(root, record.id, bytes);
      onRecordUpdated(updated);
      setSourcePageCount(plan.length);
      dispatch({ type: 'reset', pageCount: plan.length });
      setVersion((value) => value + 1);
      return true;
    } catch (cause) {
      onError(describeError(cause));
      return false;
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }, [plan, sourcePageCount, root, record.id, onRecordUpdated, onError]);

  useImperativeHandle(
    ref,
    () => ({
      isDirty: () => !isIdentityPlan(plan, sourcePageCount),
      save,
      buildBytes,
    }),
    [plan, sourcePageCount, save, buildBytes],
  );

  function goTo(next: number) {
    if (pageCount === 0) return;

    const clamped = Math.min(pageCount, Math.max(1, Math.round(next)));
    setPageNumber(clamped);
    setPageDraft(String(clamped));
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (mode !== 'single') return;

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
  }, [pageNumber, pageCount, mode]);

  function zoomBy(factor: number) {
    setFit('none');
    setZoom(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor)));
  }

  function openPage(index: number) {
    setMode('single');
    goTo(index + 1);
  }

  const undo = () => dispatch({ type: 'undo' });
  const revert = () => dispatch({ type: 'reset', pageCount: sourcePageCount });

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="pdf-group">
          {mode === 'single' ? (
            <>
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
                  disabled={pageCount === 0}
                />
                <span>of {pageCount || pdf?.numPages || '…'}</span>
              </form>
              <button
                type="button"
                className="ghost"
                onClick={() => goTo(pageNumber + 1)}
                disabled={pageCount === 0 || pageNumber >= pageCount}
                aria-label="Next page"
              >
                ›
              </button>
            </>
          ) : (
            <span className="pdf-page-count">
              {pageCount} {pageCount === 1 ? 'page' : 'pages'}
            </span>
          )}
        </div>

        <div className="pdf-group">
          <button
            type="button"
            className="ghost"
            onClick={undo}
            disabled={planState.history.length === 0 || busy}
            title="Undo the last page change"
          >
            Undo
          </button>
          <button
            type="button"
            className="ghost"
            onClick={revert}
            disabled={!dirty || busy}
            title="Restore the original page order and rotations"
          >
            Revert
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setMode(mode === 'single' ? 'grid' : 'single')}
            aria-pressed={mode === 'grid'}
            disabled={!pdf}
          >
            {mode === 'grid' ? 'Single page' : 'Pages'}
          </button>

          {mode === 'single' && (
            <>
              <button
                type="button"
                className="ghost"
                onClick={() => zoomBy(1 / 1.2)}
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                className="ghost"
                onClick={() => zoomBy(1.2)}
                aria-label="Zoom in"
              >
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
            </>
          )}
        </div>
      </div>

      <div
        className={mode === 'grid' ? 'pdf-grid' : 'pdf-scroll'}
        ref={containerRef}
      >
        {mode === 'grid' ? (
          plan.map((page, index) => (
            <article className="pdf-page-card" key={page.key}>
              <button
                type="button"
                className="pdf-page-open"
                onClick={() => openPage(index)}
                title={`Open page ${index + 1}`}
              >
                <PageThumbnail pdf={pdf} entry={page} />
                <span className="pdf-page-number">{index + 1}</span>
              </button>
              <div className="pdf-page-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => dispatch({ type: 'rotate', index, delta: -90 })}
                  aria-label={`Rotate page ${index + 1} left`}
                  title="Rotate left"
                  disabled={busy}
                >
                  ↺
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => dispatch({ type: 'rotate', index, delta: 90 })}
                  aria-label={`Rotate page ${index + 1} right`}
                  title="Rotate right"
                  disabled={busy}
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => dispatch({ type: 'move', index, delta: -1 })}
                  aria-label={`Move page ${index + 1} left`}
                  title="Move left"
                  disabled={index === 0 || busy}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => dispatch({ type: 'move', index, delta: 1 })}
                  aria-label={`Move page ${index + 1} right`}
                  title="Move right"
                  disabled={index === pageCount - 1 || busy}
                >
                  →
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => dispatch({ type: 'duplicate', index })}
                  aria-label={`Duplicate page ${index + 1}`}
                  title="Duplicate"
                  disabled={busy}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() => dispatch({ type: 'remove', index })}
                  aria-label={`Delete page ${index + 1}`}
                  title="Delete"
                  disabled={pageCount <= 1 || busy}
                >
                  ✕
                </button>
              </div>
            </article>
          ))
        ) : (
          <>
            <canvas ref={canvasRef} className="pdf-canvas" />
            {loading && <p className="pdf-loading">Loading PDF…</p>}
          </>
        )}
      </div>
    </div>
  );
}

type ThumbnailProps = {
  pdf: PDFDocumentProxy | null;
  entry: PageEntry;
};

function PageThumbnail({ pdf, entry }: ThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((value) => value.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px' },
    );

    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !visible) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let task: RenderTask | null = null;

    void (async () => {
      const page = await pdf.getPage(entry.source + 1);
      if (cancelled) return;

      const rotation = pageRotation(page, entry);
      const base = page.getViewport({ scale: 1, rotation });
      const scale = Math.min(
        THUMB_MAX_WIDTH / base.width,
        THUMB_MAX_HEIGHT / base.height,
      );
      const viewport = page.getViewport({ scale, rotation });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);

      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      task = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await task.promise;
    })().catch((cause) => {
      if (cancelled) return;
      const name = (cause as { name?: string } | null)?.name;
      if (name === 'RenderingCancelledException') return;
      // A broken thumbnail should not replace the document with an error.
      console.warn('Could not render PDF thumbnail', cause);
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, entry.source, entry.rotation, visible]);

  return <canvas ref={canvasRef} className="pdf-thumb" />;
}

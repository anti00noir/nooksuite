import type { PDFDocument } from 'pdf-lib';
import type { PDFPageProxy } from 'pdfjs-dist';

/**
 * One page in the edited document. `source` points at the page in the PDF the
 * plan was built from, so duplicated pages share a source index.
 */
export type PageEntry = {
  /** Stable React key; never compared when deciding whether the plan is dirty. */
  key: string;
  /** Zero-based page index in the source PDF. */
  source: number;
  /** Extra clockwise rotation in degrees: 0, 90, 180, or 270. */
  rotation: number;
};

export type PagePlan = PageEntry[];

export type PlanState = {
  plan: PagePlan;
  history: PagePlan[];
};

export type PlanAction =
  | { type: 'reset'; pageCount: number }
  | { type: 'rotate'; index: number; delta: number }
  | { type: 'move'; index: number; delta: number }
  | { type: 'duplicate'; index: number }
  | { type: 'remove'; index: number }
  | { type: 'undo' };

const MAX_HISTORY = 50;
let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `page-${keyCounter}`;
}

function normalizeRotation(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** The untouched page order for a PDF with `pageCount` pages. */
export function identityPlan(pageCount: number): PagePlan {
  return Array.from({ length: pageCount }, (_, source) => ({
    key: nextKey(),
    source,
    rotation: 0,
  }));
}

/** True when the plan matches the source PDF exactly, so nothing needs saving. */
export function isIdentityPlan(
  plan: PagePlan,
  sourcePageCount: number,
): boolean {
  return (
    plan.length === sourcePageCount &&
    plan.every((entry, index) => entry.source === index && entry.rotation === 0)
  );
}

/** The absolute rotation pdf.js should render for a plan entry. */
export function pageRotation(
  page: Pick<PDFPageProxy, 'rotate'>,
  entry: PageEntry,
): number {
  return normalizeRotation(normalizeRotation(page.rotate) + entry.rotation);
}

export function planReducer(state: PlanState, action: PlanAction): PlanState {
  const commit = (plan: PagePlan): PlanState => ({
    plan,
    history: [...state.history, state.plan].slice(-MAX_HISTORY),
  });

  switch (action.type) {
    case 'reset':
      return { plan: identityPlan(action.pageCount), history: [] };

    case 'undo': {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return { plan: previous, history: state.history.slice(0, -1) };
    }

    case 'rotate': {
      if (!state.plan[action.index]) return state;
      const plan = state.plan.map((entry, index) =>
        index === action.index
          ? {
              ...entry,
              rotation: normalizeRotation(entry.rotation + action.delta),
            }
          : entry,
      );
      return commit(plan);
    }

    case 'move': {
      const target = action.index + action.delta;
      if (
        action.index < 0 ||
        action.index >= state.plan.length ||
        target < 0 ||
        target >= state.plan.length
      ) {
        return state;
      }

      const plan = [...state.plan];
      const [entry] = plan.splice(action.index, 1);
      plan.splice(target, 0, entry);
      return commit(plan);
    }

    case 'duplicate': {
      const entry = state.plan[action.index];
      if (!entry) return state;

      const plan = [...state.plan];
      plan.splice(action.index + 1, 0, { ...entry, key: nextKey() });
      return commit(plan);
    }

    case 'remove': {
      if (state.plan.length <= 1 || !state.plan[action.index]) return state;
      return commit(state.plan.filter((_, index) => index !== action.index));
    }
  }
}

export type PdfSourceBytes = ArrayBuffer | Uint8Array;

/**
 * Rewrite `sourceBytes` in the plan's page order and bake in rotations.
 *
 * pdf-lib's `copyPages` is the supported way to reorder pages. It does not
 * carry over acroforms or outlines, which is documented in the README; page
 * annotations that live on copied pages are copied with the page.
 */
export async function buildPdfBytes(
  sourceBytes: PdfSourceBytes,
  plan: PagePlan,
  sourcePageCount: number,
): Promise<Uint8Array> {
  if (plan.length === 0) {
    throw new Error('A PDF must keep at least one page.');
  }

  if (isIdentityPlan(plan, sourcePageCount)) {
    return sourceBytes instanceof Uint8Array
      ? sourceBytes
      : new Uint8Array(sourceBytes);
  }

  // pdf-lib is only needed when the user actually saves or exports an edit, so
  // keep it out of the viewer's initial chunk.
  const { PDFDocument, degrees } = await import('pdf-lib');

  const source = await PDFDocument.load(sourceBytes);
  const output = await PDFDocument.create();
  const pages = await output.copyPages(
    source,
    plan.map((entry) => entry.source),
  );

  pages.forEach((page, index) => {
    output.addPage(page);
    const extra = plan[index].rotation;
    if (extra) {
      page.setRotation(degrees(normalizeRotation(page.getRotation().angle + extra)));
    }
  });

  copyMetadata(source, output);

  return output.save();
}

function copyMetadata(source: PDFDocument, output: PDFDocument) {
  const copy = (
    read: () => string | undefined,
    write: (value: string) => void,
  ) => {
    const value = read();
    if (value) write(value);
  };

  copy(
    () => source.getTitle(),
    (value) => output.setTitle(value),
  );
  copy(
    () => source.getAuthor(),
    (value) => output.setAuthor(value),
  );
  copy(
    () => source.getSubject(),
    (value) => output.setSubject(value),
  );
  copy(
    () => source.getCreator(),
    (value) => output.setCreator(value),
  );

  const keywords = source.getKeywords();
  if (keywords) {
    const list = keywords
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    if (list.length > 0) output.setKeywords(list);
  }
}

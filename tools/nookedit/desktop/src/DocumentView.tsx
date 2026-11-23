import { useCallback, useEffect, useRef, useState } from 'react';
import { save as saveFile } from '@tauri-apps/plugin-dialog';

import { ConfirmDialog } from './ConfirmDialog';
import { ImagePreview } from './ImagePreview';
import { MarkdownPreview } from './MarkdownPreview';
import { PdfViewer } from './PdfViewer';
import { TextEditor } from './TextEditor';
import { api, type DocumentRecord } from './lib/api';
import {
  documentKind,
  exportFilters,
  isTextKind,
  kindLabel,
  wordCount,
} from './lib/documents';
import { describeError } from './lib/errors';
import { formatDate, formatSize } from './lib/format';

type Props = {
  root: string;
  record: DocumentRecord;
  onBack: () => void;
  onRecordUpdated: (record: DocumentRecord) => void;
};

export function DocumentView({ root, record, onBack, onRecordUpdated }: Props) {
  const kind = documentKind(record);
  const editable = isTextKind(kind);

  const [content, setContent] = useState('');
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(editable);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const saving = useRef(false);

  const dirty = editable && !loading && content !== baseline;

  useEffect(() => {
    if (!editable) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setError(null);

    void api
      .readDocumentText(root, record.id)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setBaseline(text);
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(describeError(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [root, record.id, editable]);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const save = useCallback(async () => {
    if (!editable || loading || saving.current || content === baseline) return false;

    saving.current = true;
    setBusy(true);
    setError(null);

    try {
      const updated = await api.saveDocument(root, record.id, content);
      setBaseline(content);
      onRecordUpdated(updated);
      setNotice('Saved.');
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [editable, loading, content, baseline, root, record.id, onRecordUpdated]);

  useEffect(() => {
    if (!editable) return;

    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editable, save]);

  function onContentChange(next: string) {
    setContent(next);
    // A "Saved." banner left over from the last save would be misleading as
    // soon as the buffer changes again.
    setNotice(null);
  }

  function requestBack() {
    if (dirty) setConfirmDiscard(true);
    else onBack();
  }

  async function exportDocument() {
    if (busy || loading) return;

    try {
      const destination = await saveFile({
        title: 'Export document',
        defaultPath: record.name,
        filters: exportFilters(kind),
      });

      if (typeof destination !== 'string') return;

      setBusy(true);
      setError(null);
      setNotice(null);

      await api.exportDocument(
        root,
        record.id,
        destination,
        editable ? content : null,
      );
      setNotice(`Exported to ${destination}.`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="document">
      <header className="doc-header">
        <button type="button" className="ghost back" onClick={requestBack}>
          ← Library
        </button>

        <div className="doc-heading">
          <h1 title={record.name}>
            {record.name}
            {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
          </h1>
          <p className="doc-sub">
            {kindLabel(kind)}
            <span aria-hidden="true"> · </span>
            {formatSize(record.size)}
            <span aria-hidden="true"> · </span>
            Updated {formatDate(record.updatedAt)}
          </p>
        </div>

        <div className="doc-header-actions">
          {kind === 'markdown' && (
            <button type="button" onClick={() => setPreview((value) => !value)}>
              {preview ? 'Write' : 'Preview'}
            </button>
          )}
          {editable && (
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={!dirty || busy}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
          <button type="button" onClick={() => void exportDocument()} disabled={busy || loading}>
            Export
          </button>
        </div>
      </header>

      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="status notice">{notice}</p>}

      {editable ? (
        loading ? (
          <div className="doc-loading">Loading document…</div>
        ) : loadError ? (
          <div className="doc-loading">{loadError}</div>
        ) : (
          <>
            <div className={preview ? 'editor-pane is-hidden' : 'editor-pane'}>
              <TextEditor
                key={record.id}
                value={content}
                markdown={kind === 'markdown'}
                visible={!preview}
                onChange={onContentChange}
                onSave={() => void save()}
              />
            </div>

            {preview && (
              <div className="preview-pane">
                <MarkdownPreview source={content} />
              </div>
            )}

            <footer className="doc-footer">
              <span>{wordCount(content)} words</span>
              <span>{content.length} characters</span>
              <span className={dirty ? 'dirty' : undefined}>
                {dirty ? 'Unsaved changes' : 'Saved'}
              </span>
            </footer>
          </>
        )
      ) : kind === 'pdf' ? (
        <PdfViewer root={root} record={record} onError={setError} />
      ) : kind === 'image' ? (
        <ImagePreview root={root} record={record} onError={setError} />
      ) : (
        <section className="unsupported">
          <h2>No preview for this file yet</h2>
          <p>
            {record.name} is stored in the library. Editing and preview for this
            format are not implemented; you can still export a copy.
          </p>
          <button type="button" className="primary" onClick={() => void exportDocument()}>
            Export a copy
          </button>
        </section>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          busy={false}
          title="Discard changes?"
          body={`"${record.name}" has unsaved changes. Leaving the editor discards them.`}
          confirmLabel="Discard changes"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onBack();
          }}
        />
      )}
    </main>
  );
}

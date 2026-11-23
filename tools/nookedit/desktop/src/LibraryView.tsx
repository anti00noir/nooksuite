import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';

import { ConfirmDialog } from './ConfirmDialog';
import { DocumentRow } from './DocumentRow';
import { api, type DocumentRecord, type LibrarySnapshot } from './lib/api';
import { describeError } from './lib/errors';
import { formatSize } from './lib/format';

type Props = {
  snapshot: LibrarySnapshot;
  busy: boolean;
  error: string | null;
  notice: string | null;
  onSnapshot: (snapshot: LibrarySnapshot) => void;
  onOpenLibrary: (path: string) => Promise<boolean>;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
};

export function LibraryView({
  snapshot,
  busy,
  error,
  notice,
  onSnapshot,
  onOpenLibrary,
  onBusy,
  onError,
  onNotice,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const importing = useRef(false);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || importing.current) return;

      importing.current = true;
      onBusy(true);
      onError(null);
      onNotice(null);

      try {
        const outcome = await api.importDocuments(snapshot.root, paths);
        onSnapshot(outcome.library);

        if (outcome.imported.length > 0) {
          onNotice(
            `Imported ${outcome.imported.length} ${
              outcome.imported.length === 1 ? 'document' : 'documents'
            }.`,
          );
        }
        if (outcome.errors.length > 0) {
          onError(
            `${outcome.errors.length} file${
              outcome.errors.length === 1 ? '' : 's'
            } could not be imported. ${outcome.errors[0]}`,
          );
        }
      } catch (cause) {
        onError(describeError(cause));
      } finally {
        importing.current = false;
        onBusy(false);
      }
    },
    [snapshot.root, onBusy, onError, onNotice, onSnapshot],
  );

  // Tauri delivers native drops here; HTML5 drop events do not carry paths.
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let disposed = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          setDragging(false);
          void importPaths(event.payload.paths);
        } else if (event.payload.type === 'leave') {
          setDragging(false);
        } else {
          setDragging(true);
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause) => onError(describeError(cause)));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths, onError]);

  const rename = useCallback(
    async (id: string, name: string) => {
      onBusy(true);
      onError(null);
      onNotice(null);

      try {
        onSnapshot(await api.renameDocument(snapshot.root, id, name));
        onNotice('Document renamed.');
        return true;
      } catch (cause) {
        onError(describeError(cause));
        return false;
      } finally {
        onBusy(false);
      }
    },
    [snapshot.root, onBusy, onError, onNotice, onSnapshot],
  );

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  async function confirmDelete() {
    if (!pendingDelete) return;

    onBusy(true);
    onError(null);
    onNotice(null);

    try {
      onSnapshot(await api.removeDocument(snapshot.root, pendingDelete.id));
      onNotice(`Deleted "${pendingDelete.name}".`);
      setPendingDelete(null);
    } catch (cause) {
      onError(describeError(cause));
    } finally {
      onBusy(false);
    }
  }

  async function chooseFiles() {
    if (!isTauri()) return;

    const selection = await open({
      multiple: true,
      directory: false,
      title: 'Import documents',
    });
    const paths = Array.isArray(selection) ? selection : selection ? [selection] : [];

    await importPaths(paths);
  }

  async function changeLibrary() {
    if (!isTauri()) return;

    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose a library folder',
    });

    if (typeof selected === 'string') await onOpenLibrary(selected);
  }

  const totalSize = snapshot.records.reduce((sum, record) => sum + record.size, 0);

  return (
    <main className="library">
      <header className="topbar">
        <div className="brand">
          <h1>NookEdit</h1>
          <p className="library-path" title={snapshot.root}>
            {snapshot.root}
          </p>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="primary"
            onClick={() => void chooseFiles()}
            disabled={busy}
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => void changeLibrary()}
            disabled={busy}
          >
            Change library
          </button>
        </div>
      </header>

      <div className="library-summary">
        <span>
          {snapshot.records.length}{' '}
          {snapshot.records.length === 1 ? 'document' : 'documents'}
        </span>
        <span>{formatSize(totalSize)}</span>
        <span>Drop files anywhere to import</span>
      </div>

      {error && (
        <p className="status error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="status notice">{notice}</p>}

      {snapshot.records.length === 0 ? (
        <section className="empty">
          <h2>No documents yet</h2>
          <p>Import a file or drop one anywhere in this window.</p>
          <button
            type="button"
            className="primary"
            onClick={() => void chooseFiles()}
            disabled={busy}
          >
            Import documents
          </button>
        </section>
      ) : (
        <ul className="doc-list">
          {snapshot.records.map((record) => (
            <DocumentRow
              key={record.id}
              record={record}
              busy={busy}
              onDelete={setPendingDelete}
              onRename={rename}
            />
          ))}
        </ul>
      )}

      {dragging && (
        <div className="drop-overlay">
          <div>Drop files to import</div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          busy={busy}
          title="Delete document"
          body={`Delete "${pendingDelete.name}"? Its file is removed from the library folder.`}
          confirmLabel="Delete document"
          onCancel={cancelDelete}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </main>
  );
}

import { useEffect, useState } from 'react';

import { api, type DocumentRecord } from './lib/api';
import { describeError } from './lib/errors';

type Props = {
  root: string;
  record: DocumentRecord;
  onError: (message: string | null) => void;
};

export function ImagePreview({ root, record, onError }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;

    void api
      .readDocumentBytes(root, record.id)
      .then((buffer) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(
          new Blob([buffer], { type: record.mediaType }),
        );
        setUrl(objectUrl);
      })
      .catch((cause) => {
        if (!disposed) onError(describeError(cause));
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [root, record.id, record.mediaType, onError]);

  return (
    <div className="image-stage">
      {url ? (
        <img src={url} alt={record.name} />
      ) : (
        <p className="doc-loading">Loading image…</p>
      )}
    </div>
  );
}

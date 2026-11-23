import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { indentWithTab } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'transparent',
      color: '#eceef0',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      lineHeight: '1.65',
    },
    '.cm-content': { padding: '20px 0' },
    '.cm-line': { padding: '0 20px' },
    '.cm-gutters': {
      border: 'none',
      backgroundColor: 'transparent',
      color: '#5c646c',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(124, 196, 255, 0.22)',
    },
    '.cm-cursor': { borderLeftColor: '#7cc4ff' },
  },
  { dark: true },
);

type Props = {
  value: string;
  markdown: boolean;
  visible: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

export function TextEditor({ value, markdown: isMarkdown, visible, onChange, onSave }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          oneDark,
          editorTheme,
          isMarkdown ? markdown() : [],
          EditorState.tabSize.of(2),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
      parent,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is keyed by document id by its parent, so it is created once
    // per document. The language is the only extension that can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMarkdown]);

  useEffect(() => {
    if (visible) viewRef.current?.requestMeasure();
  }, [visible]);

  return <div ref={parentRef} className="editor-host" />;
}

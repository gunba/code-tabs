import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useUnsavedTextEditor } from "./UnsavedTextEditors";

interface UseTextFileEditorOptions {
  id: string;
  title: string;
  initialText: string;
  read: () => Promise<string>;
  write: (value: string) => Promise<void>;
}

export interface TextFileEditorController {
  text: string;
  saved: string;
  loading: boolean;
  dirty: boolean;
  seedKey: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  preRef: RefObject<HTMLPreElement | null>;
  setText: (value: string) => void;
  currentValue: () => string;
  reload: () => Promise<void>;
  reset: (value: string) => void;
  save: () => Promise<string>;
  syncScroll: () => void;
}

// [CM-26] Shared uncontrolled text-file editor lifecycle: load/reseed,
// DOM-fresh save, dirty tracking, syntax-overlay scroll sync, and unsaved guard.
export function useTextFileEditor({
  id,
  title,
  initialText,
  read,
  write,
}: UseTextFileEditorOptions): TextFileEditorController {
  const [text, setText] = useState(initialText);
  const [saved, setSaved] = useState(initialText);
  const [loading, setLoading] = useState(true);
  const [seedKey, setSeedKey] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const loadSeqRef = useRef(0);

  const currentValue = useCallback(
    () => textareaRef.current?.value ?? text,
    [text],
  );

  const reset = useCallback((value: string) => {
    setText(value);
    setSaved(value);
    setSeedKey((k) => k + 1);
    setLoading(false);
  }, []);

  const reload = useCallback(async () => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    setLoading(true);
    let value = initialText;
    try {
      value = await read();
    } catch {
      value = initialText;
    }
    if (loadSeqRef.current !== seq) return;
    reset(value);
  }, [initialText, read, reset]);

  useEffect(() => { void reload(); }, [reload]);

  const save = useCallback(async () => {
    const value = currentValue();
    await write(value);
    setText(value);
    setSaved(value);
    return value;
  }, [currentValue, write]);

  const syncScroll = useCallback(() => {
    if (!textareaRef.current || !preRef.current) return;
    preRef.current.scrollTop = textareaRef.current.scrollTop;
    preRef.current.scrollLeft = textareaRef.current.scrollLeft;
  }, []);

  useUnsavedTextEditor(id, () => {
    if (loading) return null;
    const after = currentValue();
    if (after === saved) return null;
    return { title, before: saved, after };
  });

  return {
    text,
    saved,
    loading,
    dirty: text !== saved,
    seedKey,
    textareaRef,
    preRef,
    setText,
    currentValue,
    reload,
    reset,
    save,
    syncScroll,
  };
}

interface EditorAreaProps {
  editor: TextFileEditorController;
  className: string;
  placeholder?: string;
  onSave: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
}

export function TextFileTextarea({
  editor,
  className,
  placeholder,
  onSave,
  onKeyDown,
  onFocus,
}: EditorAreaProps) {
  return (
    <textarea
      // [NU-01] Uncontrolled (defaultValue+onInput): browser owns value and
      // native undo stack; key={seedKey} remounts on source change.
      key={editor.seedKey}
      ref={editor.textareaRef}
      className={className}
      defaultValue={editor.text}
      onInput={(e) => editor.setText(e.currentTarget.value)}
      spellCheck={false}
      placeholder={placeholder}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "s") {
          e.preventDefault();
          onSave();
          return;
        }
        onKeyDown?.(e);
      }}
    />
  );
}

interface HighlightedEditorAreaProps extends Omit<EditorAreaProps, "className"> {
  highlightedHtml: string;
  textareaClassName?: string;
}

export function HighlightedTextFileEditor({
  editor,
  highlightedHtml,
  textareaClassName = "pane-textarea sh-textarea",
  placeholder,
  onSave,
  onKeyDown,
  onFocus,
}: HighlightedEditorAreaProps) {
  return (
    <div className="sh-container" onFocus={onFocus}>
      <pre
        ref={editor.preRef}
        className="sh-pre"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: highlightedHtml + "\n" }}
      />
      <textarea
        key={editor.seedKey}
        ref={editor.textareaRef}
        className={textareaClassName}
        defaultValue={editor.text}
        onInput={(e) => editor.setText(e.currentTarget.value)}
        spellCheck={false}
        placeholder={placeholder}
        onScroll={editor.syncScroll}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === "s") {
            e.preventDefault();
            onSave();
            return;
          }
          onKeyDown?.(e);
        }}
      />
    </div>
  );
}

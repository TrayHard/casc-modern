import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Space, Spin, message } from "antd";
import { ExportOutlined, SearchOutlined } from "@ant-design/icons";
import { openPath } from "@tauri-apps/plugin-opener";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { api, humanSize } from "../../lib/api";
import { TooLargeNotice } from "./TooLargeNotice";
import type { ViewerProps } from "./types";

/// 1 MB is a comfortable upper bound for CodeMirror; above that the editor
/// noticeably stutters on large folds and find. Use TooLargeNotice instead.
export const CODE_INLINE_LIMIT = 1 * 1024 * 1024;

/// Extension → CodeMirror language. The set is wider than just `*.json`
/// because D2R's Toolbox formats are JSON inside — we re-use the highlighter.
const JSON_LIKE = new Set([
  "json",
  "model",
  "skeleton",
  "animations",
  "particles",
  "physics",
  "cloth",
  "timelines",
  "sprite", // metadata sometimes serialized as JSON; harmless if it isn't.
  "params",
  "frontend",
  "fltr",
]);

function languageFor(ext: string) {
  if (JSON_LIKE.has(ext)) return [json()];
  switch (ext) {
    case "html":
    case "htm":
      return [html()];
    case "js":
    case "mjs":
      return [javascript()];
    case "css":
      return [css()];
    case "py":
      return [python()];
    case "h":
      return [javascript()]; // close enough for C headers — keyword color
    default:
      return [];
  }
}

function bytesToString(bytes: number[]): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

interface Props extends ViewerProps {
  /** If true, parse text as JSON and pretty-print before showing. */
  prettyJson?: boolean;
}

export function CodeViewer({ meta, prettyJson }: Props) {
  const ext = useMemo(() => extOf(meta.path), [meta.path]);
  const tooLarge = meta.size > CODE_INLINE_LIMIT;
  const [bytes, setBytes] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [truncated, setTruncated] = useState(false);
  /// CodeMirror needs an absolute pixel height to enable its internal
  /// scroller. A `%` height resolves to the editor's natural size, so a
  /// long file overflows the wrapper and the page can't be scrolled.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const [editorPx, setEditorPx] = useState(400);

  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const sync = () => setEditorPx(Math.max(el.clientHeight, 120));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // CodeMirror's searchKeymap only fires when the editor has focus. The user
  // pressing Ctrl+F without first clicking inside the editor would otherwise
  // get nothing. Catch the shortcut at window level and route it manually.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.ctrlKey || e.metaKey;
      if (cmd && e.key.toLowerCase() === "f") {
        const view = editorViewRef.current;
        if (!view) return;
        e.preventDefault();
        view.focus();
        openSearchPanel(view);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (tooLarge) {
      setBytes(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .readFilePreview(meta.path, CODE_INLINE_LIMIT)
      .then((p) => {
        if (cancelled) return;
        setBytes(p.bytes);
        setTruncated(p.truncated);
      })
      .catch((e) => {
        if (!cancelled) {
          message.error(`Read failed: ${e}`);
          setBytes(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path, tooLarge]);

  const text = useMemo(() => {
    if (!bytes) return "";
    const raw = bytesToString(bytes);
    if (!prettyJson) return raw;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [bytes, prettyJson]);

  async function openExternally() {
    setOpening(true);
    try {
      const temp = await api.extractToTemp(meta.path);
      await openPath(temp);
      message.success(`Opened ${temp}`);
    } catch (e) {
      message.error(`Open failed: ${e}`);
    } finally {
      setOpening(false);
    }
  }

  if (tooLarge) {
    return (
      <TooLargeNotice
        path={meta.path}
        size={meta.size}
        limit={CODE_INLINE_LIMIT}
        kind="text"
      />
    );
  }

  const extensions = useMemo(
    () => [
      ...languageFor(ext),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      // Ctrl+F / F3 / Shift+F3 / Esc bindings for the native panel. Lives
      // inside the editor so it never leaks into the surrounding UI.
      search({ top: true }),
      keymap.of(searchKeymap),
    ],
    [ext]
  );

  return (
    <Spin spinning={loading}>
      <Space style={{ marginBottom: 8 }}>
        <Button
          size="small"
          icon={<ExportOutlined />}
          loading={opening}
          onClick={openExternally}
        >
          Open externally
        </Button>
        <Button
          size="small"
          icon={<SearchOutlined />}
          onClick={() => {
            const view = editorViewRef.current;
            if (view) {
              view.focus();
              openSearchPanel(view);
            }
          }}
        >
          Find (Ctrl+F)
        </Button>
      </Space>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          message={`Showing first ${humanSize(CODE_INLINE_LIMIT)} of ${humanSize(meta.size)}.`}
          style={{ marginBottom: 8 }}
        />
      )}
      <div
        ref={wrapperRef}
        style={{ height: "calc(100vh - 360px)", overflow: "hidden" }}
      >
        <CodeMirror
          value={text}
          theme={oneDark}
          extensions={extensions}
          height={`${editorPx}px`}
          onCreateEditor={(view) => {
            editorViewRef.current = view;
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: false,
            foldGutter: true,
          }}
        />
      </div>
    </Spin>
  );
}

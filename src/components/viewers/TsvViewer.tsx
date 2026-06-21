import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Alert, Button, Empty, Input, Space, Spin, Typography, message } from "antd";
import { ExportOutlined } from "@ant-design/icons";
import { openPath } from "@tauri-apps/plugin-opener";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, errMsg, humanSize } from "../../lib/api";
import { usePrefs } from "../../lib/prefs";
import type { ViewerProps } from "./types";

const { Text } = Typography;
const TSV_LIMIT = 4 * 1024 * 1024; // read up to 4 MB of table data
const COL_W = 160;
const INDEX_W = 64;
const ROW_H = 28;
const HEADER_H = 30;

const HEADER_BG = "#1f1f1f";
const INDEX_BG = "#161616";
const BORDER = "1px solid rgba(255,255,255,0.12)";
const BORDER_SOFT = "1px solid rgba(255,255,255,0.06)";

// Hoisted static cell styles. Each virtual cell spreads one of these and adds
// only its dynamic left/width/height (+ header background) — so a scroll frame
// no longer reconstructs hundreds of full style objects from scratch.
const HEADER_CELL_BASE: CSSProperties = {
  position: "absolute",
  top: 0,
  height: HEADER_H,
  boxSizing: "border-box",
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  fontWeight: 600,
  borderRight: BORDER,
  borderBottom: BORDER,
};
const INDEX_CELL_BASE: CSSProperties = {
  position: "sticky",
  left: 0,
  zIndex: 1,
  width: INDEX_W,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: INDEX_BG,
  color: "#888",
  borderRight: BORDER,
  borderBottom: BORDER_SOFT,
};
const BODY_CELL_BASE: CSSProperties = {
  position: "absolute",
  top: 0,
  boxSizing: "border-box",
  padding: "0 8px",
  display: "flex",
  alignItems: "center",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  borderRight: BORDER_SOFT,
  borderBottom: BORDER_SOFT,
};

type SortDir = "asc" | "desc" | null;
type Parsed = { headers: string[]; rows: string[][]; tabular: boolean };

function parseTsv(text: string): Parsed {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { headers: [], rows: [], tabular: false };
  const headers = lines[0].split("\t");
  const sample = lines.slice(0, 25);
  const tabbed = sample.filter((l) => l.includes("\t")).length;
  const tabular =
    headers.length >= 2 && tabbed >= Math.max(1, sample.length - 1);
  const rows: string[][] = lines.slice(1).map((l) => {
    const cells = l.split("\t");
    const row = new Array<string>(headers.length);
    for (let i = 0; i < headers.length; i++) row[i] = cells[i] ?? "";
    return row;
  });
  return { headers, rows, tabular };
}

// Auto-size each column to the widest cell (or its header) it holds, so columns
// fit their content on first render. We scan every row for the longest value per
// column (cheap char-length compare), then measure just that one + the header on
// a canvas — no DOM layout. Clamped so a stray long cell can't make a column huge.
const MIN_COL_W = 48;
const MAX_COL_W = 600;
function measureColWidths(headers: string[], rows: string[][]): number[] {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return headers.map(() => COL_W);
  const ff =
    getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  ctx.font = `12px ${ff}`;
  const longest = headers.map(() => "");
  for (const row of rows) {
    for (let c = 0; c < headers.length; c++) {
      const v = row[c] ?? "";
      if (v.length > longest[c].length) longest[c] = v;
    }
  }
  return headers.map((h, c) => {
    const headerW = ctx.measureText(h).width + 16 + 16; // padding + sort arrow
    const cellW = ctx.measureText(longest[c]).width + 16; // padding
    const w = Math.ceil(Math.max(headerW, cellW));
    return Math.min(MAX_COL_W, Math.max(MIN_COL_W, w));
  });
}

// Auto-fit width for a single column (double-click on its resize handle). Same
// metrics as measureColWidths but scans only the one column.
function measureColWidth(header: string, rows: string[][], col: number): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return COL_W;
  const ff =
    getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  ctx.font = `12px ${ff}`;
  let longest = "";
  for (const row of rows) {
    const v = row[col] ?? "";
    if (v.length > longest.length) longest = v;
  }
  const headerW = ctx.measureText(header).width + 16 + 16;
  const cellW = ctx.measureText(longest).width + 16;
  const w = Math.ceil(Math.max(headerW, cellW));
  return Math.min(MAX_COL_W, Math.max(MIN_COL_W, w));
}

/// Tab-separated table viewer for D2R's Excel-style .txt files. Hand-rolled grid
/// that virtualizes BOTH rows and columns (antd's virtual table renders every
/// column, which janks on 100+-column tables), so a 106-column file only mounts
/// the cells actually on screen.
export function TsvViewer({ meta }: ViewerProps) {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const { prefs } = usePrefs();
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [colWidths, setColWidths] = useState<number[]>([]);
  const resizing = useRef<{ col: number; startX: number; startW: number } | null>(
    null
  );
  const didResize = useRef(false);

  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [areaH, setAreaH] = useState(420);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setText(null);
    setQuery("");
    setSortCol(null);
    setSortDir(null);
    api
      .readTextPreview(meta.path, TSV_LIMIT)
      .then((p) => {
        if (!cancelled) {
          setText(p.text);
          setTruncated(p.truncated);
        }
      })
      .catch((e) => {
        if (!cancelled) message.error(`Read failed: ${errMsg(e)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path]);

  // Fill down to ~16px above the window bottom, adapting to the actual top
  // position (so the table never runs off the bottom edge).
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const sync = () => {
      const top = el.getBoundingClientRect().top;
      setAreaH(Math.max(window.innerHeight - top - 16, 180));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(document.body);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
    // Re-subscribe when the table first renders (text null -> data); the
    // observer/listener handle live resizes after that.
  }, [text]);

  const parsed = useMemo(
    () => (text !== null ? parseTsv(text) : null),
    [text]
  );

  // Auto-size columns to their content whenever a new table loads (manual
  // drag-resize still overrides per column afterwards).
  useEffect(() => {
    if (parsed) setColWidths(measureColWidths(parsed.headers, parsed.rows));
  }, [parsed]);

  function onResizeMove(e: MouseEvent) {
    const r = resizing.current;
    if (!r) return;
    const w = Math.max(48, r.startW + (e.clientX - r.startX));
    didResize.current = true;
    setColWidths((prev) => {
      const next = prev.slice();
      next[r.col] = w;
      return next;
    });
  }
  function onResizeEnd() {
    resizing.current = null;
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeEnd);
  }
  function onResizeStart(e: React.MouseEvent, col: number) {
    e.preventDefault();
    e.stopPropagation();
    didResize.current = false;
    resizing.current = { col, startX: e.clientX, startW: colWidths[col] ?? COL_W };
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", onResizeEnd);
  }
  // Double-click the border → fit that column to its widest cell/header.
  function autoFitCol(col: number) {
    if (!parsed) return;
    const w = measureColWidth(parsed.headers[col] ?? "", parsed.rows, col);
    setColWidths((prev) => {
      const next = prev.slice();
      next[col] = w;
      return next;
    });
  }

  const filteredRows = useMemo(() => {
    if (!parsed) return [];
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return parsed.rows;
    return parsed.rows.filter((cells) => {
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [parsed, deferredQuery]);

  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return filteredRows;
    const col = sortCol;
    const sign = sortDir === "asc" ? 1 : -1;
    return [...filteredRows].sort(
      (a, b) =>
        sign *
        (a[col] ?? "").localeCompare(b[col] ?? "", undefined, { numeric: true })
    );
  }, [filteredRows, sortCol, sortDir]);

  function toggleSort(col: number) {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  }

  const colCount = parsed?.headers.length ?? 0;

  const rowVirtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: Math.max(2, prefs.table_overscan),
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: colCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i] ?? COL_W,
    overscan: 4,
  });

  // Re-measure column positions whenever a width changes (drag-resize).
  useEffect(() => {
    colVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colWidths]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();
  const totalH = rowVirtualizer.getTotalSize();
  const bodyW = colVirtualizer.getTotalSize();
  const totalW = INDEX_W + bodyW;

  async function openExternally() {
    setOpening(true);
    try {
      const temp = await api.extractToTemp(meta.path);
      await openPath(temp);
    } catch (e) {
      message.error(`Open failed: ${errMsg(e)}`);
    } finally {
      setOpening(false);
    }
  }

  if (!parsed) return <Spin spinning={loading} />;
  if (!parsed.tabular) {
    return (
      <Empty
        description="This .txt isn't a tab-separated table — use the Text tab."
        style={{ marginTop: 48 }}
      />
    );
  }

  const filtered = sortedRows.length !== parsed.rows.length;

  return (
    <div
      ref={outerRef}
      style={{ display: "flex", flexDirection: "column", height: areaH }}
    >
      <Space style={{ marginBottom: 8, flex: "0 0 auto" }} wrap>
        <Button
          size="small"
          icon={<ExportOutlined />}
          loading={opening}
          onClick={openExternally}
        >
          Open externally
        </Button>
        <Input.Search
          placeholder="Filter rows…"
          allowClear
          size="small"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 240 }}
        />
        <Text type="secondary">
          {filtered
            ? `${sortedRows.length.toLocaleString()} / ${parsed.rows.length.toLocaleString()} rows`
            : `${parsed.rows.length.toLocaleString()} rows`}{" "}
          × {parsed.headers.length} cols
        </Text>
      </Space>
      {truncated && (
        <Alert
          type="warning"
          showIcon
          message={`Showing first ${humanSize(TSV_LIMIT)} of ${humanSize(meta.size)}.`}
          style={{ marginBottom: 8, flex: "0 0 auto" }}
        />
      )}

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          position: "relative",
          border: BORDER,
          borderRadius: 4,
          fontVariantNumeric: "tabular-nums",
          fontSize: 12,
        }}
      >
        <div
          style={{ width: totalW, height: HEADER_H + totalH, position: "relative" }}
        >
          {/* Header strip — sticky to the top, scrolls horizontally. */}
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 3,
              height: HEADER_H,
              width: totalW,
            }}
          >
            <div
              style={{
                position: "sticky",
                left: 0,
                zIndex: 4,
                width: INDEX_W,
                height: HEADER_H,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxSizing: "border-box",
                background: HEADER_BG,
                borderRight: BORDER,
                borderBottom: BORDER,
                fontWeight: 600,
              }}
            >
              #
            </div>
            {virtualCols.map((vc) => {
              const ci = vc.index;
              const active = sortCol === ci;
              const arrow = !active ? "" : sortDir === "asc" ? " ▲" : " ▼";
              const label = parsed.headers[ci] || `col ${ci + 1}`;
              return (
                <div
                  key={vc.key}
                  onClick={() => {
                    if (didResize.current) {
                      didResize.current = false;
                      return;
                    }
                    toggleSort(ci);
                  }}
                  title={label}
                  style={{
                    ...HEADER_CELL_BASE,
                    left: INDEX_W + vc.start,
                    width: vc.size,
                    background: active ? "#2a2a2a" : HEADER_BG,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                    {label}
                  </span>
                  <span style={{ opacity: 0.7 }}>{arrow}</span>
                  <div
                    onMouseDown={(e) => onResizeStart(e, ci)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      autoFitCol(ci);
                    }}
                    title="Drag to resize · double-click to fit"
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      width: 6,
                      height: "100%",
                      cursor: "col-resize",
                    }}
                  />
                </div>
              );
            })}
          </div>

          {/* Body — each row absolutely positioned; index cell sticks left. */}
          {virtualRows.map((vr) => {
            const cells = sortedRows[vr.index];
            return (
              <div
                key={vr.key}
                style={{
                  position: "absolute",
                  top: HEADER_H + vr.start,
                  left: 0,
                  height: vr.size,
                  width: totalW,
                }}
              >
                <div style={{ ...INDEX_CELL_BASE, height: vr.size }}>
                  {vr.index + 1}
                </div>
                {virtualCols.map((vc) => (
                  <div
                    key={vc.key}
                    style={{
                      ...BODY_CELL_BASE,
                      left: INDEX_W + vc.start,
                      width: vc.size,
                      height: vr.size,
                    }}
                  >
                    {cells[vc.index]}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Space, Table, Tag, Typography, message } from "antd";
import type { TableProps } from "antd";
import {
  CloudOutlined,
  ExportOutlined,
  RollbackOutlined,
} from "@ant-design/icons";
import { ThumbIcon } from "./ThumbIcon";
import { isForeignLocale, isLowend, usePrefs } from "../lib/prefs";
import { api, errMsg, IndexEntry, humanSize, parentPath } from "../lib/api";
import type { Selection } from "../lib/selection";

const { Text } = Typography;

interface Props {
  path: string;
  onNavigate: (s: Selection) => void;
  onExport: (path: string) => void;
  /** Export an explicit set of selected items (multi-select). */
  onExportPaths?: (paths: string[]) => void;
  onContextMenu?: (
    x: number,
    y: number,
    target: Selection,
    /** The effective selection at right-click time (≥1 path). */
    paths: string[]
  ) => void;
}

type Row = {
  key: string;
  kind: "up" | "dir" | "file";
  name: string;
  path: string;
  size: number;
  local: boolean;
};

type SortState = { columnKey: "name" | "size"; order: "ascend" | "descend" };
const DEFAULT_SORT: SortState = { columnKey: "name", order: "ascend" };

export function DirectoryView({
  path,
  onNavigate,
  onExport,
  onExportPaths,
  onContextMenu,
}: Props) {
  const [entries, setEntries] = useState<IndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Explorer-style multi-selection: a set of selected row keys plus the anchor
  // a Shift-click ranges from. Reset whenever we navigate to another folder.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const [sortState, setSortState] = useState<SortState>(DEFAULT_SORT);
  // antd's virtual Table needs a numeric height + column widths; measure the
  // table viewport (fills to the window bottom, tracks the splitter).
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ h: 420, w: 800 });

  const { prefs, installedLocales } = usePrefs();
  const visibleEntries = useMemo(() => {
    let out = entries;
    if (prefs.hide_other_locales) {
      out = out.filter((e) => !isForeignLocale(e.locale_flags, installedLocales));
    }
    if (prefs.hide_lowend) {
      out = out.filter((e) => e.is_dir || !isLowend(e.name));
    }
    return out;
  }, [entries, prefs.hide_other_locales, prefs.hide_lowend, installedLocales]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelectedKeys(new Set());
    setAnchorKey(null);
    api
      .listDir(path)
      .then((es) => {
        if (!cancelled) setEntries(es);
      })
      .catch((e) => {
        if (!cancelled) {
          message.error(`list_dir failed: ${errMsg(e)}`);
          setEntries([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const sync = () => {
      const top = el.getBoundingClientRect().top;
      const h = Math.max(window.innerHeight - top - 16, 180);
      const w = el.clientWidth;
      setArea((prev) => (prev.h === h && prev.w === w ? prev : { h, w }));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (path !== "") {
      out.push({
        key: "__up__",
        kind: "up",
        name: "..",
        path: parentPath(path),
        size: 0,
        local: true,
      });
    }
    for (const e of visibleEntries) {
      out.push({
        key: e.path,
        kind: e.is_dir ? "dir" : "file",
        name: e.name,
        path: e.path,
        size: e.size,
        local: e.local,
      });
    }
    return out;
  }, [visibleEntries, path]);

  // We sort the data ourselves (columns use `sorter: true`, i.e. controlled)
  // so the on-screen order is known here — Shift-range selection walks exactly
  // what the user sees. The ".." row is always pinned to the top.
  const displayRows = useMemo<Row[]>(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      if (a.kind === "up") return -1;
      if (b.kind === "up") return 1;
      if (sortState.columnKey === "size") {
        const d = a.size - b.size;
        return sortState.order === "descend" ? -d : d;
      }
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      const c = a.name.localeCompare(b.name);
      return sortState.order === "descend" ? -c : c;
    });
    return arr;
  }, [rows, sortState]);

  // Selectable rows in display order (everything except "..").
  const selectable = useMemo(
    () => displayRows.filter((r) => r.kind !== "up"),
    [displayRows]
  );

  const selectedCount = selectedKeys.size;

  function selectedPathsInOrder(): string[] {
    return selectable.filter((r) => selectedKeys.has(r.key)).map((r) => r.path);
  }

  function handleRowClick(row: Row, e: React.MouseEvent) {
    if (row.kind === "up") {
      setSelectedKeys(new Set());
      setAnchorKey(null);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey && anchorKey) {
      const i = selectable.findIndex((r) => r.key === anchorKey);
      const j = selectable.findIndex((r) => r.key === row.key);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        const range = selectable.slice(lo, hi + 1).map((r) => r.key);
        setSelectedKeys((prev) =>
          ctrl ? new Set([...prev, ...range]) : new Set(range)
        );
        return; // keep the existing anchor for further Shift extension
      }
    }
    if (ctrl) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
      setAnchorKey(row.key);
      return;
    }
    setSelectedKeys(new Set([row.key]));
    setAnchorKey(row.key);
  }

  function handleRowContextMenu(row: Row, e: React.MouseEvent) {
    if (!onContextMenu || row.kind === "up") return;
    e.preventDefault();
    let paths: string[];
    if (selectedKeys.has(row.key) && selectedKeys.size > 1) {
      // Right-clicked inside the current multi-selection → act on all of it.
      paths = selectedPathsInOrder();
    } else {
      // Right-clicked outside the selection → reduce to just this row, the way
      // Explorer does.
      setSelectedKeys(new Set([row.key]));
      setAnchorKey(row.key);
      paths = [row.path];
    }
    onContextMenu(
      e.clientX,
      e.clientY,
      { kind: row.kind === "dir" ? "dir" : "file", path: row.path },
      paths
    );
  }

  const onTableChange: TableProps<Row>["onChange"] = (_p, _f, sorter) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const key = s?.columnKey;
    if (s?.order && (key === "name" || key === "size")) {
      setSortState({ columnKey: key, order: s.order });
    } else {
      setSortState(DEFAULT_SORT);
    }
  };

  const SIZE_W = 120;
  const KIND_W = 80;
  const nameW = Math.max(160, area.w - SIZE_W - KIND_W - 8);
  const totalW = nameW + SIZE_W + KIND_W;

  // Hoisted so identity is stable across selection clicks / scroll (a fresh
  // array each render makes the virtual Table re-derive columns every time).
  const columns = useMemo<TableProps<Row>["columns"]>(
    () => [
      {
        title: "Name",
        dataIndex: "name",
        key: "name",
        width: nameW,
        ellipsis: true,
        render: (_v, row) => {
          const notLocal = row.kind === "file" && !row.local;
          return (
            <span style={notLocal ? { opacity: 0.4 } : undefined}>
              <span style={{ marginRight: 6 }}>
                {row.kind === "up" ? (
                  <RollbackOutlined />
                ) : (
                  <ThumbIcon
                    name={row.name}
                    path={row.path}
                    isDir={row.kind === "dir"}
                    size={row.size}
                    where="browser"
                  />
                )}
              </span>
              {row.name}
              {notLocal && (
                <CloudOutlined style={{ marginLeft: 6 }} title="Not downloaded" />
              )}
            </span>
          );
        },
        sorter: true,
        sortOrder: sortState.columnKey === "name" ? sortState.order : null,
        sortDirections: ["ascend", "descend"],
      },
      {
        title: "Size",
        dataIndex: "size",
        key: "size",
        width: SIZE_W,
        align: "right",
        render: (_v, row) =>
          row.kind === "file" ? (
            humanSize(row.size)
          ) : (
            <Text type="secondary">—</Text>
          ),
        sorter: true,
        sortOrder: sortState.columnKey === "size" ? sortState.order : null,
        sortDirections: ["ascend", "descend"],
      },
      {
        title: "Kind",
        key: "kind",
        width: KIND_W,
        render: (_v, row) =>
          row.kind === "file" ? (
            <Tag>{extOf(row.name) || "file"}</Tag>
          ) : (
            <Tag color="blue">dir</Tag>
          ),
      },
    ],
    [nameW, sortState.columnKey, sortState.order]
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Text strong>📁 {path || "<root>"}</Text>
        <Text type="secondary">
          ({visibleEntries.filter((e) => !e.is_dir).length} files,{" "}
          {visibleEntries.filter((e) => e.is_dir).length} folders
          {selectedCount > 0 ? ` · ${selectedCount} selected` : ""})
        </Text>
        <div style={{ flex: 1 }} />
        <Space>
          {selectedCount > 0 && onExportPaths && (
            <Button
              size="small"
              type="primary"
              icon={<ExportOutlined />}
              onClick={() => onExportPaths(selectedPathsInOrder())}
            >
              Export selected ({selectedCount})…
            </Button>
          )}
          <Button
            size="small"
            icon={<ExportOutlined />}
            onClick={() => onExport(path)}
          >
            {path === "" ? "Export all…" : "Export folder…"}
          </Button>
        </Space>
      </div>
      <div ref={areaRef} style={{ flex: 1, minHeight: 0 }}>
        <Table<Row>
          className="dv-table"
          size="small"
          loading={loading}
          dataSource={displayRows}
          pagination={false}
          virtual
          scroll={{ x: totalW, y: area.h }}
          onChange={onTableChange}
          rowClassName={(row) =>
            selectedKeys.has(row.key) ? "dv-row-selected" : ""
          }
          onRow={(row) => ({
            onMouseDown: (e) => {
              // Double-click / Shift-click would normally select text spanning
              // rows; suppress that so users see a clean row highlight.
              if (e.detail > 1 || e.shiftKey) e.preventDefault();
            },
            onClick: (e) => handleRowClick(row, e),
            onDoubleClick: () => {
              if (row.kind === "file") {
                onNavigate({ kind: "file", path: row.path });
              } else {
                onNavigate({ kind: "dir", path: row.path });
              }
            },
            onContextMenu: (e) => handleRowContextMenu(row, e),
            style: { cursor: "pointer", userSelect: "none" },
          })}
          columns={columns}
        />
      </div>
    </div>
  );
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

import { useEffect, useMemo, useState } from "react";
import { Button, Space, Table, Tag, Typography, message } from "antd";
import {
  ExportOutlined,
  FileOutlined,
  FolderOutlined,
  RollbackOutlined,
} from "@ant-design/icons";
import { api, IndexEntry, humanSize, parentPath } from "../lib/api";
import type { Selection } from "../lib/selection";

const { Text } = Typography;

interface Props {
  path: string;
  onNavigate: (s: Selection) => void;
  onExport: (path: string) => void;
  onContextMenu?: (x: number, y: number, target: Selection) => void;
}

type Row = {
  key: string;
  kind: "up" | "dir" | "file";
  name: string;
  path: string;
  size: number;
};

export function DirectoryView({ path, onNavigate, onExport, onContextMenu }: Props) {
  const [entries, setEntries] = useState<IndexEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listDir(path)
      .then((es) => {
        if (!cancelled) setEntries(es);
      })
      .catch((e) => {
        if (!cancelled) {
          message.error(`list_dir failed: ${e}`);
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

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (path !== "") {
      out.push({
        key: "__up__",
        kind: "up",
        name: "..",
        path: parentPath(path),
        size: 0,
      });
    }
    for (const e of entries) {
      out.push({
        key: e.path,
        kind: e.is_dir ? "dir" : "file",
        name: e.name,
        path: e.path,
        size: e.size,
      });
    }
    return out;
  }, [entries, path]);

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
          ({entries.filter((e) => !e.is_dir).length} files,{" "}
          {entries.filter((e) => e.is_dir).length} folders)
        </Text>
        <div style={{ flex: 1 }} />
        <Space>
          <Button
            size="small"
            icon={<ExportOutlined />}
            onClick={() => onExport(path)}
          >
            {path === "" ? "Export all…" : "Export folder…"}
          </Button>
        </Space>
      </div>
      <Table<Row>
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        scroll={{ y: "calc(100vh - 200px)" }}
        sticky
        onRow={(row) => ({
          onMouseDown: (e) => {
            // Double-click would normally select text spanning the row; this
            // suppresses that so users see a clean row highlight.
            if (e.detail > 1) e.preventDefault();
          },
          onDoubleClick: () => {
            if (row.kind === "file") {
              onNavigate({ kind: "file", path: row.path });
            } else {
              onNavigate({ kind: "dir", path: row.path });
            }
          },
          onContextMenu: (e) => {
            if (!onContextMenu || row.kind === "up") return;
            e.preventDefault();
            onContextMenu(e.clientX, e.clientY, {
              kind: row.kind === "dir" ? "dir" : "file",
              path: row.path,
            });
          },
          style: { cursor: "pointer", userSelect: "none" },
        })}
        columns={[
          {
            title: "Name",
            dataIndex: "name",
            key: "name",
            render: (_v, row) => (
              <span>
                {row.kind === "up" && <RollbackOutlined style={{ marginRight: 6 }} />}
                {row.kind === "dir" && <FolderOutlined style={{ marginRight: 6 }} />}
                {row.kind === "file" && <FileOutlined style={{ marginRight: 6 }} />}
                {row.name}
              </span>
            ),
            sorter: (a, b) => {
              if (a.kind === "up") return -1;
              if (b.kind === "up") return 1;
              if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
              return a.name.localeCompare(b.name);
            },
            defaultSortOrder: "ascend",
          },
          {
            title: "Size",
            dataIndex: "size",
            key: "size",
            width: 120,
            align: "right",
            render: (_v, row) =>
              row.kind === "file" ? humanSize(row.size) : <Text type="secondary">—</Text>,
            sorter: (a, b) => a.size - b.size,
          },
          {
            title: "Kind",
            key: "kind",
            width: 80,
            render: (_v, row) =>
              row.kind === "file" ? (
                <Tag>{extOf(row.name) || "file"}</Tag>
              ) : (
                <Tag color="blue">dir</Tag>
              ),
          },
        ]}
      />
    </div>
  );
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

import { useState } from "react";
import { Button, Empty, Input, Modal, Space, Tag, Typography } from "antd";
import {
  CloseOutlined,
  EditOutlined,
  FileOutlined,
  FolderOutlined,
  StarFilled,
} from "@ant-design/icons";
import type { Bookmark } from "../lib/api";
import type { Selection } from "../lib/selection";

const { Text } = Typography;

interface Props {
  bookmarks: Bookmark[];
  onNavigate: (s: Selection) => void;
  onUpdate: (next: Bookmark[]) => void;
}

export function BookmarkBar({ bookmarks, onNavigate, onUpdate }: Props) {
  const [editing, setEditing] = useState<{ idx: number; name: string } | null>(
    null
  );

  function remove(idx: number) {
    const next = bookmarks.slice();
    next.splice(idx, 1);
    onUpdate(next);
  }

  function rename(idx: number, name: string) {
    const next = bookmarks.slice();
    next[idx] = { ...next[idx], name };
    onUpdate(next);
  }

  return (
    <div
      style={{
        padding: 8,
        borderBottom: "1px solid #303030",
        background: "#1a1a1a",
      }}
    >
      <Space style={{ marginBottom: 6 }}>
        <StarFilled style={{ color: "#fadb14" }} />
        <Text strong style={{ color: "#ddd" }}>
          Bookmarks
        </Text>
        <Text type="secondary">({bookmarks.length})</Text>
      </Space>
      {bookmarks.length === 0 ? (
        <Empty
          imageStyle={{ height: 28 }}
          description={
            <Text type="secondary" style={{ fontSize: 11 }}>
              Right-click a file or folder → Add to bookmarks
            </Text>
          }
        />
      ) : (
        <div style={{ maxHeight: 180, overflow: "auto" }}>
          {bookmarks.map((b, i) => (
            <div
              key={`${b.path}:${i}`}
              style={{
                display: "flex",
                alignItems: "center",
                padding: "2px 4px",
                borderRadius: 3,
                cursor: "pointer",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLDivElement).style.background = "#2a2a2a")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLDivElement).style.background = "transparent")
              }
              onClick={() =>
                onNavigate({ kind: b.is_dir ? "dir" : "file", path: b.path })
              }
              title={b.path}
            >
              {b.is_dir ? (
                <FolderOutlined style={{ marginRight: 6, color: "#69b1ff" }} />
              ) : (
                <FileOutlined style={{ marginRight: 6, color: "#ccc" }} />
              )}
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "#ddd",
                  fontSize: 13,
                }}
              >
                {b.name}
              </span>
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing({ idx: i, name: b.name });
                }}
              />
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(i);
                }}
              />
            </div>
          ))}
        </div>
      )}
      <Modal
        open={editing !== null}
        title="Rename bookmark"
        onCancel={() => setEditing(null)}
        onOk={() => {
          if (editing) {
            rename(editing.idx, editing.name.trim() || bookmarks[editing.idx].name);
            setEditing(null);
          }
        }}
        okText="Save"
        destroyOnClose
      >
        <Input
          autoFocus
          value={editing?.name ?? ""}
          onChange={(e) =>
            setEditing((p) => (p ? { ...p, name: e.target.value } : p))
          }
          onPressEnter={(e) => {
            if (editing) {
              const v = (e.target as HTMLInputElement).value.trim();
              rename(editing.idx, v || bookmarks[editing.idx].name);
              setEditing(null);
            }
          }}
        />
        {editing && (
          <Text type="secondary" style={{ display: "block", marginTop: 8 }}>
            <Tag>{bookmarks[editing.idx]?.is_dir ? "dir" : "file"}</Tag>
            <Text code style={{ wordBreak: "break-all" }}>
              {bookmarks[editing.idx]?.path}
            </Text>
          </Text>
        )}
      </Modal>
    </div>
  );
}

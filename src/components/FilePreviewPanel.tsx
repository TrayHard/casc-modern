import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Descriptions,
  Empty,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { ArrowLeftOutlined, ExportOutlined } from "@ant-design/icons";
import { api, FileMeta, humanSize, parentPath } from "../lib/api";
import { viewersFor } from "./viewers/registry";
import type { Selection } from "../lib/selection";

const { Text } = Typography;

interface Props {
  selectedPath: string;
  onNavigate: (s: Selection) => void;
  onExport: (path: string) => void;
}

export function FilePreviewPanel({ selectedPath, onNavigate, onExport }: Props) {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getFileMeta(selectedPath)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((e) => {
        if (!cancelled) {
          message.error(`Meta failed: ${e}`);
          setMeta(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  const viewers = useMemo(() => (meta ? viewersFor(meta) : []), [meta]);

  if (!selectedPath) {
    return <Empty description="Select a file in the tree" style={{ marginTop: 80 }} />;
  }

  return (
    <Spin spinning={loading}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div
          style={{
            marginBottom: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Button
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() =>
              onNavigate({ kind: "dir", path: parentPath(selectedPath) })
            }
          >
            Back
          </Button>
          <div style={{ flex: 1 }} />
          <Space>
            <Button
              size="small"
              icon={<ExportOutlined />}
              onClick={() => onExport(selectedPath)}
            >
              Export file…
            </Button>
          </Space>
        </div>
        <Descriptions
          size="small"
          column={1}
          bordered
          style={{ marginBottom: 12 }}
          items={[
            {
              key: "path",
              label: "Path",
              children: (
                <Text copyable code style={{ wordBreak: "break-all" }}>
                  {selectedPath}
                </Text>
              ),
            },
            {
              key: "size",
              label: "Size",
              children: meta ? (
                <>
                  {humanSize(meta.size)}{" "}
                  <Text type="secondary">({meta.size.toLocaleString()} B)</Text>
                </>
              ) : (
                "—"
              ),
            },
            {
              key: "kind",
              label: "Kind",
              children: meta ? <Tag>{meta.kind}</Tag> : "—",
            },
          ]}
        />
        <div style={{ flex: 1, minHeight: 0 }}>
          {meta && viewers.length > 0 && (
            <Tabs
              defaultActiveKey={viewers[0].id}
              items={viewers.map((v) => ({
                key: v.id,
                label: v.label,
                children: <v.Component meta={meta} />,
              }))}
            />
          )}
        </div>
      </div>
    </Spin>
  );
}

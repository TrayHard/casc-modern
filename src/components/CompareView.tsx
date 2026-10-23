import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Pagination,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import {
  ArrowLeftOutlined,
  FolderOpenOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  errMsg,
  humanSize,
  type ComparePreview,
  type CompareResult,
  type DiffEntry,
  type DiffPage,
  type DiffStatus,
} from "../lib/api";

const { Text, Title } = Typography;
const PAGE_SIZE = 100;

const STATUS_COLOR: Record<DiffStatus, string> = {
  added: "green",
  removed: "red",
  changed: "gold",
  unverified: "default",
};

type PreviewState = {
  loading: boolean;
  value: ComparePreview | null;
  error: string | null;
};
const emptyPreview: PreviewState = { loading: false, value: null, error: null };

function PreviewPane({
  label,
  path,
  state,
  absent,
}: {
  label: string;
  path: string;
  state: PreviewState;
  absent: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid #303030",
        borderRadius: 8,
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #303030" }}>
        <Text strong>{label}</Text>
        <div>
          <Text
            type="secondary"
            style={{ fontSize: 12, overflowWrap: "anywhere" }}
          >
            {path}
          </Text>
        </div>
        {state.value && (
          <Text type="secondary">{humanSize(state.value.size)}</Text>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
        {absent ? (
          <Empty description="File is absent in this version" />
        ) : state.loading ? (
          <Spin />
        ) : state.error ? (
          <Alert
            type="warning"
            message="Preview unavailable"
            description={state.error}
          />
        ) : state.value?.kind === "image" ? (
          <img
            src={`data:image/png;base64,${state.value.image_b64}`}
            alt={`Preview of ${path} in ${label}`}
            style={{
              display: "block",
              maxWidth: "100%",
              height: "auto",
              imageRendering: "auto",
            }}
          />
        ) : state.value ? (
          <>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                margin: 0,
                fontSize: 12,
                fontFamily: "Consolas, monospace",
              }}
            >
              {state.value.text}
            </pre>
            {state.value.truncated && (
              <Text type="secondary">Preview truncated.</Text>
            )}
          </>
        ) : (
          <Empty description="Select a changed file" />
        )}
      </div>
    </div>
  );
}

export function CompareView({
  defaultLeft,
  onClose,
}: {
  defaultLeft: string | null;
  onClose: () => void;
}) {
  const [leftPath, setLeftPath] = useState(defaultLeft ?? "");
  const [rightPath, setRightPath] = useState("");
  const [comparing, setComparing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<{
    phase: string;
    processed: number;
    total: number;
  } | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DiffStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState(false);
  const [diffPage, setDiffPage] = useState<DiffPage>({ entries: [], total: 0 });
  const [selected, setSelected] = useState<DiffEntry | null>(null);
  const [leftPreview, setLeftPreview] = useState<PreviewState>(emptyPreview);
  const [rightPreview, setRightPreview] = useState<PreviewState>(emptyPreview);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    listen<{ phase: string; processed: number; total: number }>(
      "compare_progress",
      (event) => {
        if (active) setProgress(event.payload);
      },
    )
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch((error) => {
        if (active) message.warning(`Progress unavailable: ${errMsg(error)}`);
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const pick = useCallback(
    async (side: "left" | "right") => {
      const path = await openDialog({
        directory: true,
        multiple: false,
        defaultPath:
          (side === "left" ? leftPath : rightPath) || defaultLeft || undefined,
      });
      if (typeof path !== "string") return;
      if (side === "left") setLeftPath(path);
      else setRightPath(path);
    },
    [leftPath, rightPath, defaultLeft],
  );

  const compare = useCallback(async () => {
    if (!leftPath.trim() || !rightPath.trim()) {
      message.warning("Choose both storage folders.");
      return;
    }
    setComparing(true);
    setCancelling(false);
    setProgress(null);
    setResult(null);
    setSelected(null);
    setDiffPage({ entries: [], total: 0 });
    try {
      const next = await api.compareStorages(leftPath.trim(), rightPath.trim());
      setResult(next);
      setPage(1);
      setStatus("all");
      setQueryInput("");
      setQuery("");
    } catch (error) {
      if (!/comparison cancelled/i.test(errMsg(error))) {
        message.error(`Comparison failed: ${errMsg(error)}`);
      }
    } finally {
      setComparing(false);
    }
  }, [leftPath, rightPath]);

  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    setListing(true);
    api
      .comparePage(query, status, (page - 1) * PAGE_SIZE, PAGE_SIZE)
      .then((value) => {
        if (!cancelled) setDiffPage(value);
      })
      .catch((error) => {
        if (!cancelled) message.error(`Diff list failed: ${errMsg(error)}`);
      })
      .finally(() => {
        if (!cancelled) setListing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result, query, status, page]);

  useEffect(() => {
    if (!selected) {
      setLeftPreview(emptyPreview);
      setRightPreview(emptyPreview);
      return;
    }
    let cancelled = false;
    const load = (
      side: "left" | "right",
      setter: (value: PreviewState) => void,
    ) => {
      setter({ loading: true, value: null, error: null });
      api
        .comparePreview(side, selected.path)
        .then((value) => {
          if (!cancelled) setter({ loading: false, value, error: null });
        })
        .catch((error) => {
          if (!cancelled)
            setter({ loading: false, value: null, error: errMsg(error) });
        });
    };
    if (selected.status !== "added") load("left", setLeftPreview);
    else setLeftPreview(emptyPreview);
    if (selected.status !== "removed") load("right", setRightPreview);
    else setRightPreview(emptyPreview);
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const close = async () => {
    setClosing(true);
    try {
      await api.closeComparison();
      onClose();
    } catch (error) {
      message.error(`Could not close comparison: ${errMsg(error)}`);
      setClosing(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.cancelComparison();
    } catch (error) {
      message.error(errMsg(error));
      setCancelling(false);
    }
  };

  const columns = [
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      width: 118,
      render: (value: DiffStatus) => (
        <Tag color={STATUS_COLOR[value]}>{value}</Tag>
      ),
    },
    { title: "Path", dataIndex: "path", key: "path", ellipsis: true },
    {
      title: "Left size",
      dataIndex: "left_size",
      key: "left_size",
      width: 105,
      render: (value: number | null) =>
        value === null ? "—" : humanSize(value),
    },
    {
      title: "Right size",
      dataIndex: "right_size",
      key: "right_size",
      width: 105,
      render: (value: number | null) =>
        value === null ? "—" : humanSize(value),
    },
  ];

  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
        overflow: "auto",
        padding: 16,
        gap: 12,
      }}
    >
      <Space align="center">
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={close}
          disabled={comparing}
          loading={closing}
        >
          Back to browser
        </Button>
        <Title level={4} style={{ margin: 0 }}>
          Compare storages
        </Title>
      </Space>
      <Text type="secondary">
        Choose the older and newer game storage folders. Game files are read
        from CASC archives, so an executable alone is not enough.
      </Text>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "end",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 300px", minWidth: 240 }}>
          <Text type="secondary">Left version</Text>
          <Space.Compact style={{ width: "100%", marginTop: 4 }}>
            <Input
              aria-label="Left storage folder"
              disabled={comparing || closing}
              value={leftPath}
              onChange={(event) => setLeftPath(event.target.value)}
              placeholder="Choose a CASC storage folder"
            />
            <Button
              disabled={comparing || closing}
              icon={<FolderOpenOutlined />}
              onClick={() => pick("left")}
              title="Browse left storage"
            />
          </Space.Compact>
        </div>
        <Button
          icon={<SwapOutlined />}
          onClick={() => {
            setLeftPath(rightPath);
            setRightPath(leftPath);
          }}
          disabled={comparing}
          title="Swap versions"
        />
        <div style={{ flex: "1 1 300px", minWidth: 240 }}>
          <Text type="secondary">Right version</Text>
          <Space.Compact style={{ width: "100%", marginTop: 4 }}>
            <Input
              aria-label="Right storage folder"
              disabled={comparing || closing}
              value={rightPath}
              onChange={(event) => setRightPath(event.target.value)}
              placeholder="Choose a CASC storage folder"
            />
            <Button
              disabled={comparing || closing}
              icon={<FolderOpenOutlined />}
              onClick={() => pick("right")}
              title="Browse right storage"
            />
          </Space.Compact>
        </div>
        <Button
          type="primary"
          disabled={closing}
          loading={comparing}
          onClick={compare}
        >
          Compare
        </Button>
      </div>
      {comparing && (
        <Space.Compact style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            style={{ flex: 1 }}
            message={
              progress
                ? `${progress.phase}${progress.total ? ` · ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}` : "…"}`
                : "Opening storages…"
            }
          />
          <Button disabled={cancelling} onClick={cancel}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        </Space.Compact>
      )}
      {result && (
        <>
          <Space wrap>
            <Text type="secondary">
              Builds {result.left_info.build} → {result.right_info.build}
            </Text>
            <Tag color="green">
              Added {result.summary.added.toLocaleString()}
            </Tag>
            <Tag color="red">
              Removed {result.summary.removed.toLocaleString()}
            </Tag>
            <Tag color="gold">
              Changed {result.summary.changed.toLocaleString()}
            </Tag>
            {result.summary.unverified > 0 && (
              <Tag>Unverified {result.summary.unverified.toLocaleString()}</Tag>
            )}
          </Space>
          <Text type="secondary">
            Added and removed are relative to the left version. Image previews
            show the first frame. Sizes are reported by each storage and may
            reflect compression.
          </Text>
          {result.summary.unverified > 0 && (
            <Alert
              type="warning"
              showIcon
              message="Some contents could not be verified. Select an Unverified file to see the reason. Files may be listed in a version without being installed locally."
            />
          )}
          <Space style={{ width: "100%" }}>
            <Input.Search
              aria-label="Filter paths"
              placeholder="Filter paths"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              allowClear
              style={{ width: 360, maxWidth: "60vw" }}
            />
            <Select
              aria-label="Filter status"
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              style={{ width: 145 }}
              options={["all", "added", "removed", "changed", "unverified"].map(
                (value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                }),
              )}
            />
          </Space>
          <div style={{ minHeight: 0, maxHeight: "36%", overflow: "auto" }}>
            <Table<DiffEntry>
              size="small"
              rowKey="path"
              dataSource={diffPage.entries}
              columns={columns}
              loading={listing}
              pagination={false}
              scroll={{ y: 230 }}
              locale={{
                emptyText:
                  query || status !== "all"
                    ? "No differences match this filter"
                    : "No differences found",
              }}
              rowClassName={(row) =>
                selected?.path === row.path ? "dv-row-selected" : ""
              }
              onRow={(row) => ({
                onClick: () => setSelected(row),
                style: { cursor: "pointer" },
              })}
            />
          </div>
          <Pagination
            size="small"
            current={page}
            pageSize={PAGE_SIZE}
            total={diffPage.total}
            onChange={setPage}
            showSizeChanger={false}
            showTotal={(total) => `${total.toLocaleString()} differences`}
          />
          {selected?.verification_error && (
            <Alert
              type="warning"
              showIcon
              message={selected.verification_error}
            />
          )}
          <div style={{ flex: 1, minHeight: 160, display: "flex", gap: 12 }}>
            <PreviewPane
              label={`Left · build ${result.left_info.build}`}
              path={selected?.path ?? result.left_path}
              state={leftPreview}
              absent={selected?.status === "added"}
            />
            <PreviewPane
              label={`Right · build ${result.right_info.build}`}
              path={selected?.path ?? result.right_path}
              state={rightPreview}
              absent={selected?.status === "removed"}
            />
          </div>
        </>
      )}
      {!result && !comparing && (
        <Empty
          description="Choose two storage folders to see their differences."
          style={{ margin: "auto" }}
        />
      )}
    </div>
  );
}

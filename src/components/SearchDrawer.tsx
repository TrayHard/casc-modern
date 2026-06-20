import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  List,
  Progress,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import {
  CloseOutlined,
  FileSearchOutlined,
  PlayCircleOutlined,
  StopOutlined,
} from "@ant-design/icons";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  ContentHit,
  NameHit,
  SearchDone,
  SearchProgress,
  humanSize,
} from "../lib/api";
import { Selection } from "../lib/selection";

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  onNavigate: (s: Selection) => void;
}

export function SearchDrawer({ open, onClose, onNavigate }: Props) {
  const [tab, setTab] = useState<"name" | "content">("name");

  // --- name search state ---
  const [nameQuery, setNameQuery] = useState("");
  const [nameRegex, setNameRegex] = useState(false);
  const [nameHits, setNameHits] = useState<NameHit[]>([]);
  const [nameLoading, setNameLoading] = useState(false);

  useEffect(() => {
    if (!open || tab !== "name") return;
    if (nameQuery.trim().length < 2) {
      setNameHits([]);
      return;
    }
    let cancelled = false;
    setNameLoading(true);
    const handle = setTimeout(() => {
      api
        .searchNames(nameQuery, nameRegex, 500)
        .then((hits) => {
          if (!cancelled) setNameHits(hits);
        })
        .catch((e) => {
          if (!cancelled) message.error(`Search failed: ${e}`);
        })
        .finally(() => {
          if (!cancelled) setNameLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [nameQuery, nameRegex, open, tab]);

  // --- content search state ---
  const [contentQuery, setContentQuery] = useState("");
  const [contentGlob, setContentGlob] = useState("**/*.txt");
  const [contentMaxSize, setContentMaxSize] = useState(2);
  const [contentCI, setContentCI] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [contentHits, setContentHits] = useState<ContentHit[]>([]);
  const [contentDone, setContentDone] = useState<SearchDone | null>(null);
  const hitsRef = useRef<ContentHit[]>([]);

  useEffect(() => {
    if (!open) return;
    const unlisteners: Promise<UnlistenFn>[] = [];
    unlisteners.push(
      listen<ContentHit>("search_hit", (e) => {
        hitsRef.current = [...hitsRef.current, e.payload];
        setContentHits(hitsRef.current);
      })
    );
    unlisteners.push(
      listen<SearchProgress>("search_progress", (e) => setProgress(e.payload))
    );
    unlisteners.push(
      listen<SearchDone>("search_done", (e) => {
        setContentDone(e.payload);
        setRunning(false);
        setProgress(null);
      })
    );
    return () => {
      Promise.all(unlisteners).then((fns) => fns.forEach((f) => f()));
    };
  }, [open]);

  async function startContentSearch() {
    if (!contentQuery) {
      message.warning("Enter a query");
      return;
    }
    setContentHits([]);
    hitsRef.current = [];
    setContentDone(null);
    setProgress({ scanned: 0, total: 0, current_path: "", matches_so_far: 0 });
    setRunning(true);
    try {
      await api.searchContent(
        contentQuery,
        contentGlob.trim() || null,
        contentMaxSize * 1024 * 1024,
        contentCI
      );
    } catch (e) {
      message.error(`Search failed: ${e}`);
      setRunning(false);
      setProgress(null);
    }
  }

  async function cancelContentSearch() {
    try {
      await api.cancelSearch();
    } catch (e) {
      message.error(`Cancel failed: ${e}`);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <Space>
          <FileSearchOutlined /> Search
        </Space>
      }
      width={640}
      destroyOnClose={false}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as "name" | "content")}
        items={[
          {
            key: "name",
            label: "By name",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input.Search
                  placeholder="Substring or regex (min 2 chars)…"
                  value={nameQuery}
                  onChange={(e) => setNameQuery(e.target.value)}
                  allowClear
                  loading={nameLoading}
                />
                <Checkbox
                  checked={nameRegex}
                  onChange={(e) => setNameRegex(e.target.checked)}
                >
                  Regex (case-insensitive)
                </Checkbox>
                <Text type="secondary">
                  {nameHits.length} result{nameHits.length === 1 ? "" : "s"}
                  {nameHits.length >= 500 && " (capped)"}
                </Text>
                <List<NameHit>
                  size="small"
                  bordered
                  dataSource={nameHits}
                  pagination={{ pageSize: 50 }}
                  renderItem={(h) => (
                    <List.Item
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        onNavigate({
                          kind: h.is_dir ? "dir" : "file",
                          path: h.path,
                        });
                        onClose();
                      }}
                    >
                      <Space style={{ width: "100%" }}>
                        <Tag color={h.is_dir ? "blue" : "default"}>
                          {h.is_dir ? "dir" : "file"}
                        </Tag>
                        <Text code style={{ flex: 1, wordBreak: "break-all" }}>
                          {h.path}
                        </Text>
                        {!h.is_dir && (
                          <Text type="secondary">{humanSize(h.size)}</Text>
                        )}
                      </Space>
                    </List.Item>
                  )}
                />
              </Space>
            ),
          },
          {
            key: "content",
            label: "By content",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input
                  placeholder="What to search for…"
                  value={contentQuery}
                  onChange={(e) => setContentQuery(e.target.value)}
                  disabled={running}
                />
                <Input
                  placeholder='Glob filter (e.g. **/*.txt, **/data\\global\\**)'
                  value={contentGlob}
                  onChange={(e) => setContentGlob(e.target.value)}
                  disabled={running}
                />
                <Space>
                  <Text>Max file size:</Text>
                  <InputNumber
                    min={0.1}
                    max={64}
                    step={0.5}
                    value={contentMaxSize}
                    onChange={(v) => setContentMaxSize(Number(v ?? 2))}
                    disabled={running}
                    addonAfter="MB"
                  />
                  <Checkbox
                    checked={contentCI}
                    onChange={(e) => setContentCI(e.target.checked)}
                    disabled={running}
                  >
                    Case-insensitive
                  </Checkbox>
                </Space>
                <Space>
                  {!running ? (
                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      onClick={startContentSearch}
                    >
                      Start
                    </Button>
                  ) : (
                    <Button
                      danger
                      icon={<StopOutlined />}
                      onClick={cancelContentSearch}
                    >
                      Cancel
                    </Button>
                  )}
                </Space>
                {progress && (
                  <Progress
                    percent={
                      progress.total === 0
                        ? 0
                        : Math.floor((progress.scanned * 100) / progress.total)
                    }
                    format={() =>
                      `${progress.scanned}/${progress.total} · ${progress.matches_so_far} hits`
                    }
                    status={running ? "active" : "normal"}
                  />
                )}
                {contentDone && (
                  <Alert
                    type={contentDone.cancelled ? "warning" : "success"}
                    showIcon
                    message={
                      contentDone.cancelled
                        ? "Cancelled"
                        : `${contentDone.matches} hits in ${contentDone.elapsed_ms} ms`
                    }
                    description={
                      contentDone.error ? `Last error: ${contentDone.error}` : undefined
                    }
                  />
                )}
                <List<ContentHit>
                  size="small"
                  bordered
                  dataSource={contentHits}
                  pagination={{ pageSize: 25 }}
                  renderItem={(h) => (
                    <List.Item
                      style={{ cursor: "pointer" }}
                      onClick={() => {
                        onNavigate({ kind: "file", path: h.path });
                        onClose();
                      }}
                    >
                      <Space
                        direction="vertical"
                        size={2}
                        style={{ width: "100%" }}
                      >
                        <Space style={{ width: "100%" }}>
                          <Text code style={{ flex: 1, wordBreak: "break-all" }}>
                            {h.path}
                          </Text>
                          <Tag>{h.match_count}×</Tag>
                          <Text type="secondary">{humanSize(h.size)}</Text>
                        </Space>
                        <Text
                          type="secondary"
                          style={{
                            fontFamily: "Consolas, monospace",
                            fontSize: 11,
                          }}
                        >
                          @0x{h.match_offset.toString(16)}: {h.excerpt}
                        </Text>
                      </Space>
                    </List.Item>
                  )}
                />
              </Space>
            ),
          },
        ]}
      />
      <Button
        icon={<CloseOutlined />}
        onClick={onClose}
        style={{ position: "absolute", top: 16, right: 60 }}
      />
    </Drawer>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Layout, Space, Statistic, Typography, message } from "antd";
import { FolderOpenOutlined, SearchOutlined } from "@ant-design/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api, errMsg, Bookmark, OpenResult, Settings, basename } from "./lib/api";
import { Selection } from "./lib/selection";
import { StorageTree } from "./components/StorageTree";
import { DirectoryView } from "./components/DirectoryView";
import { FilePreviewPanel } from "./components/FilePreviewPanel";
import { SearchDrawer } from "./components/SearchDrawer";
import { ContextMenu } from "./components/ContextMenu";
import { ExportProgressDialog } from "./components/ExportProgressDialog";
import { BookmarkBar } from "./components/BookmarkBar";
import { UpdateButton } from "./components/UpdateButton";
import { useExporter } from "./lib/useExporter";
import {
  buildContextMenu,
  buildMultiContextMenu,
  handleContextAction,
  handleMultiContextAction,
} from "./lib/contextMenuItems";

const { Sider, Content, Header } = Layout;
const { Text } = Typography;

interface CtxMenuState {
  x: number;
  y: number;
  target: Selection;
  /** Effective selection: 1 path = single-item menu, >1 = multi menu. */
  paths: string[];
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [treeGen, setTreeGen] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  const refreshSettings = useCallback(() => {
    api.getSettings().then(setSettings).catch(() => setSettings(null));
  }, []);
  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  const exporter = useExporter(settings, refreshSettings);

  const bookmarks = settings?.bookmarks ?? [];

  const updateBookmarks = useCallback(
    async (next: Bookmark[]) => {
      try {
        await api.setBookmarks(next);
        refreshSettings();
      } catch (e) {
        message.error(`Bookmark save failed: ${errMsg(e)}`);
      }
    },
    [refreshSettings]
  );

  const toggleBookmark = useCallback(
    (target: Selection) => {
      const existing = bookmarks.findIndex((b) => b.path === target.path);
      if (existing >= 0) {
        const next = bookmarks.slice();
        next.splice(existing, 1);
        updateBookmarks(next);
      } else {
        const name = target.path === "" ? "<root>" : basename(target.path);
        updateBookmarks([
          ...bookmarks,
          { name, path: target.path, is_dir: target.kind === "dir" },
        ]);
      }
    },
    [bookmarks, updateBookmarks]
  );

  const openStorage = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const result = await api.openStorage(path);
      setStoragePath(path);
      setOpened(result);
      setSelection(null);
      setTreeGen((g) => g + 1);
      message.success(
        `Opened ${result.info.product} build ${result.info.build} (${result.indexed_files.toLocaleString()} files)`
      );
      api.getSettings().then(setSettings).catch(() => {});
    } catch (e) {
      message.error(`Failed to open: ${errMsg(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-reopen last storage on first launch.
  useEffect(() => {
    if (!settings || opened || loading) return;
    if (settings.last_storage_path) {
      openStorage(settings.last_storage_path).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // WebView2 ships its own Find Bar bound to Ctrl+F. It searches DOM text,
  // not the CodeMirror buffer, so it overlays our viewer with a useless 0/0
  // panel. Suppress the browser default; CodeMirror's keymap still fires on
  // the editor itself because preventDefault doesn't stop propagation in
  // capture phase if we don't stop it ourselves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const isFind = (cmd && k === "f") || e.key === "F3";
      // Ctrl/Cmd+F (find), Ctrl+G (find next), F3 / Shift+F3 — all open or
      // navigate the WebView2 Find Bar by default. Block all of them.
      if (isFind || (cmd && k === "g")) {
        e.preventDefault();
      }
      // With a text-like file open, CodeViewer captures Ctrl+F / F3 for its
      // in-viewer search (it mounts a `.cm-editor`). Otherwise there's nothing
      // to search in place, so fall back to opening the global Search panel.
      if (isFind && !document.querySelector(".cm-editor")) {
        setSearchOpen(true);
      }
    };
    // Capture phase on window: runs before any descendant listener AND
    // before the WebView2 host gets a chance to act on the default action.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as EventListenerOptions);
  }, []);

  const pickStorage = useCallback(async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: settings?.last_storage_path ?? undefined,
    });
    if (typeof picked !== "string") return;
    openStorage(picked);
  }, [settings, openStorage]);

  const onContextMenu = useCallback(
    (x: number, y: number, target: Selection, paths?: string[]) =>
      setCtxMenu({ x, y, target, paths: paths ?? [target.path] }),
    []
  );

  const ctxItems = useMemo(() => {
    if (!ctxMenu) return [];
    if (ctxMenu.paths.length > 1) return buildMultiContextMenu(ctxMenu.paths.length);
    const isBookmarked = bookmarks.some((b) => b.path === ctxMenu.target.path);
    return buildContextMenu({ target: ctxMenu.target, isBookmarked });
  }, [ctxMenu, bookmarks]);

  const handleCtxSelect = useCallback(
    async (key: string) => {
      if (!ctxMenu) return;
      const { target, paths } = ctxMenu;
      setCtxMenu(null);
      const actions = {
        open: setSelection,
        exportPath: exporter.exportPath,
        exportPaths: exporter.exportPaths,
        exportPathAsPng: exporter.exportPathAsPng,
        toggleBookmark,
      };
      if (paths.length > 1) {
        await handleMultiContextAction(key, paths, actions);
      } else {
        await handleContextAction(key, target, actions);
      }
    },
    [
      ctxMenu,
      exporter.exportPath,
      exporter.exportPaths,
      exporter.exportPathAsPng,
      toggleBookmark,
    ]
  );

  const rightPanel = useMemo(() => {
    if (!opened) return null;
    if (!selection) {
      return (
        <DirectoryView
          path=""
          onNavigate={setSelection}
          onExport={exporter.exportPath}
          onExportPaths={exporter.exportPaths}
          onContextMenu={onContextMenu}
        />
      );
    }
    if (selection.kind === "dir") {
      return (
        <DirectoryView
          path={selection.path}
          onNavigate={setSelection}
          onExport={exporter.exportPath}
          onExportPaths={exporter.exportPaths}
          onContextMenu={onContextMenu}
        />
      );
    }
    return (
      <FilePreviewPanel
        selectedPath={selection.path}
        onNavigate={setSelection}
        onExport={exporter.exportPath}
      />
    );
  }, [opened, selection, exporter.exportPath, exporter.exportPaths, onContextMenu]);

  return (
    <Layout style={{ height: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 16px",
          borderBottom: "1px solid #303030",
        }}
      >
        <Button
          type="primary"
          icon={<FolderOpenOutlined />}
          onClick={pickStorage}
          loading={loading}
        >
          Open storage…
        </Button>
        <Button
          icon={<SearchOutlined />}
          onClick={() => setSearchOpen(true)}
          disabled={!opened}
        >
          Search…
        </Button>
        {storagePath && (
          <Text style={{ color: "#aaa", overflow: "hidden", textOverflow: "ellipsis" }}>
            {storagePath}
          </Text>
        )}
        <div style={{ flex: 1 }} />
        {appVersion && (
          <Text
            title="Installed version"
            style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}
          >
            v{appVersion}
          </Text>
        )}
        <UpdateButton />
        {opened && (
          <Space size={24}>
            <Statistic
              title={<span style={{ color: "#aaa" }}>Product</span>}
              value={opened.info.product}
              valueStyle={{ color: "#fff", fontSize: 16 }}
            />
            <Statistic
              title={<span style={{ color: "#aaa" }}>Build</span>}
              value={opened.info.build}
              valueStyle={{ color: "#fff", fontSize: 16 }}
              groupSeparator=""
            />
            <Statistic
              title={<span style={{ color: "#aaa" }}>Files</span>}
              value={opened.indexed_files}
              valueStyle={{ color: "#fff", fontSize: 16 }}
            />
          </Space>
        )}
      </Header>
      <Layout>
        <Sider
          width={420}
          style={{
            background: "#141414",
            borderRight: "1px solid #303030",
            overflow: "hidden",
          }}
        >
          {opened ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: "100%",
                minHeight: 0,
              }}
            >
              <BookmarkBar
                bookmarks={bookmarks}
                onNavigate={setSelection}
                onUpdate={updateBookmarks}
              />
              <div style={{ flex: 1, minHeight: 0, padding: 8, overflow: "hidden" }}>
                <StorageTree
                  generation={treeGen}
                  selection={selection}
                  onSelectFile={(p) => setSelection({ kind: "file", path: p })}
                  onSelectFolder={(p) => setSelection({ kind: "dir", path: p })}
                  onContextMenu={onContextMenu}
                />
              </div>
            </div>
          ) : (
            <Text type="secondary" style={{ padding: 12, display: "block" }}>
              Open a storage to begin.
            </Text>
          )}
        </Sider>
        <Content style={{ padding: 12, overflow: "hidden" }}>
          {rightPanel}
        </Content>
      </Layout>
      <SearchDrawer
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={setSelection}
      />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxItems}
          onSelect={handleCtxSelect}
          onClose={() => setCtxMenu(null)}
        />
      )}
      <ExportProgressDialog
        running={exporter.running}
        progress={exporter.progress}
        done={exporter.done}
        onCancel={exporter.cancel}
        onDismiss={exporter.dismissDone}
      />
    </Layout>
  );
}

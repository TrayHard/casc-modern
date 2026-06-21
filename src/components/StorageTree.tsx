import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tree } from "antd";
import { CloudOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { api, IndexEntry } from "../lib/api";
import { ThumbIcon } from "./ThumbIcon";
import { iconFromTheme } from "../lib/fileIcons";
import { isForeignLocale, isLowend, usePrefs } from "../lib/prefs";
import type { Selection } from "../lib/selection";

/// antd's Tree.scrollTo isn't typed on the public ref in v5. Narrow handle
/// covers exactly what we use.
type TreeHandle = {
  scrollTo: (opts: {
    key: React.Key;
    align?: "top" | "bottom" | "auto";
    offset?: number;
  }) => void;
};

interface Props {
  /** Bumps every time a new storage is opened — forces tree reset. */
  generation: number;
  /** Drives expansion/selection in the tree. */
  selection: Selection | null;
  onSelectFile: (path: string) => void;
  onSelectFolder: (path: string) => void;
  /** Right-click on a node opens a context menu at viewport (x, y). */
  onContextMenu?: (x: number, y: number, target: Selection) => void;
}

type Node = DataNode & {
  name?: string;
  storagePath?: string | null;
  size?: number;
};

function ancestorPrefixes(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i <= segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

export function StorageTree({
  generation,
  selection,
  onSelectFile,
  onSelectFolder,
  onContextMenu,
}: Props) {
  const [data, setData] = useState<Node[]>([]);
  const [expanded, setExpanded] = useState<React.Key[]>([]);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const treeRef = useRef<any>(null);
  const [box, setBox] = useState({ h: 400, w: 400 });
  // Content width for rc-virtual-list's horizontal scrollbar, floored at the
  // container width so a collapsed/short tree fills the panel (no phantom shift)
  // and only longer names produce a horizontal scrollbar.
  const [scrollWidth, setScrollWidth] = useState(400);
  /// Dirs we've already fetched children for. Includes "" (root) once loaded.
  const loadedRef = useRef<Set<string>>(new Set());

  const { prefs, installedLocales, iconTheme } = usePrefs();
  const hideLocale = prefs.hide_other_locales;
  const hideLowend = prefs.hide_lowend;
  const thumbsOnTree = prefs.thumbnails_in_tree;

  const filterEntries = useCallback(
    (entries: IndexEntry[]): IndexEntry[] => {
      let out = entries;
      if (hideLocale) {
        out = out.filter((e) => !isForeignLocale(e.locale_flags, installedLocales));
      }
      if (hideLowend) {
        out = out.filter((e) => e.is_dir || !isLowend(e.name));
      }
      return out;
    },
    [hideLocale, hideLowend, installedLocales]
  );

  // Build a tree node. With tree thumbnails off, render a plain themed SVG icon
  // (no per-node state/context) so virtual rows stay cheap. The not-downloaded
  // hint uses a native `title` attribute (no rc-trigger Tooltip per row).
  const entryToNode = useCallback(
    (e: IndexEntry): Node => {
      const notLocal = !e.is_dir && !e.local;
      return {
        key: e.path,
        name: e.name,
        isLeaf: !e.is_dir,
        title: notLocal ? (
          <span
            title="Not downloaded — data isn't in the local storage"
            style={{ opacity: 0.4 }}
          >
            {e.name} <CloudOutlined />
          </span>
        ) : (
          e.name
        ),
        icon: thumbsOnTree ? (
          <ThumbIcon
            name={e.name}
            path={e.path}
            isDir={e.is_dir}
            size={e.size}
            where="tree"
          />
        ) : (
          iconFromTheme(iconTheme, e.name, e.is_dir)
        ),
        storagePath: e.storage_path,
        size: e.size,
      };
    },
    [thumbsOnTree, iconTheme]
  );

  // Initial root load + reset on new storage (or when filter/icons change).
  useEffect(() => {
    setData([]);
    setExpanded([]);
    setSelected([]);
    loadedRef.current = new Set();
    api
      .listDir("")
      .then((entries) => {
        setData(filterEntries(entries).map(entryToNode));
        loadedRef.current.add("");
      })
      .catch(() => setData([]));
  }, [generation, filterEntries, entryToNode]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setBox({ h: el.clientHeight, w: el.clientWidth });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Estimate the widest visible row so the horizontal scrollbar appears; never
  // below the container width so short rows still fill the panel.
  useEffect(() => {
    const INDENT = 24;
    const CHAR = 7.2;
    const BASE = 56; // switcher + icon + padding
    let max = 0;
    const walk = (nodes: Node[], depth: number) => {
      for (const n of nodes) {
        const name = n.name ?? String(n.key).split("/").pop() ?? "";
        max = Math.max(max, BASE + depth * INDENT + name.length * CHAR);
        if (n.children && expanded.includes(n.key)) {
          walk(n.children as Node[], depth + 1);
        }
      }
    };
    walk(data, 0);
    setScrollWidth(Math.max(Math.ceil(max), box.w));
  }, [data, expanded, box.w]);

  // Fetch children for `key` and merge into the tree. Idempotent.
  const ensureLoaded = useCallback(
    async (key: string): Promise<void> => {
      if (loadedRef.current.has(key)) return;
      const children = await api.listDir(key);
      setData((prev) =>
        insertChildren(prev, key, filterEntries(children).map(entryToNode))
      );
      loadedRef.current.add(key);
    },
    [filterEntries, entryToNode]
  );

  // antd lazy-load: only fires when user expands a node whose children
  // haven't been populated yet.
  const loadData = useCallback(
    async (node: Node): Promise<void> => {
      await ensureLoaded(String(node.key));
    },
    [ensureLoaded]
  );

  // External navigation: walk to selection.path, loading ancestors as needed,
  // expand them, and center the selected node in the view.
  useEffect(() => {
    if (!selection) {
      setSelected([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const segments = selection.path.split("/").filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        const prefix = segments.slice(0, i).join("/");
        if (cancelled) return;
        try {
          await ensureLoaded(prefix);
        } catch {
          return;
        }
      }
      if (cancelled) return;
      const ancestors = ancestorPrefixes(selection.path);
      // A folder bookmark expands the folder itself; a file leaf only its
      // ancestors.
      const toExpand =
        selection.kind === "file" ? ancestors.slice(0, -1) : ancestors;
      setExpanded((prev) => mergeKeys(prev, toExpand));
      setSelected([selection.path]);
      // Two rAFs: commit the state change, then let antd's virtual list lay out
      // the newly visible rows before centering the selected one.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          (treeRef.current as TreeHandle | null)?.scrollTo({
            key: selection.path,
            align: "top",
            offset: Math.max(0, box.h / 2 - 12),
          });
        });
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selection, ensureLoaded, box.h]);

  return (
    <div
      ref={containerRef}
      className="storage-tree"
      style={{ height: "100%", width: "100%" }}
    >
      <Tree<Node>
        ref={treeRef}
        treeData={data}
        loadData={(n) => loadData(n as Node)}
        expandedKeys={expanded}
        onExpand={(keys, info) => {
          const ev = info.nativeEvent as MouseEvent | undefined;
          // Shift-click on a collapsing switcher also collapses every
          // descendant folder.
          if (!info.expanded && ev?.shiftKey) {
            const node = info.node as unknown as Node;
            const drop = new Set<string>();
            const collect = (n: Node) => {
              for (const c of (n.children ?? []) as Node[]) {
                drop.add(String(c.key));
                collect(c);
              }
            };
            collect(node);
            setExpanded(keys.filter((k) => !drop.has(String(k))));
          } else {
            setExpanded(keys);
          }
        }}
        selectedKeys={selected}
        onSelect={(keys, info) => {
          setSelected(keys);
          const node = info.node as unknown as Node;
          if (node.isLeaf) {
            onSelectFile(String(node.key));
          } else {
            onSelectFolder(String(node.key));
          }
        }}
        onRightClick={({ event, node }) => {
          if (!onContextMenu) return;
          event.preventDefault();
          const n = node as unknown as Node;
          const target: Selection = n.isLeaf
            ? { kind: "file", path: String(n.key) }
            : { kind: "dir", path: String(n.key) };
          onContextMenu(event.clientX, event.clientY, target);
        }}
        showIcon
        virtual
        motion={null}
        height={box.h}
        scrollWidth={scrollWidth}
      />
    </div>
  );
}

function insertChildren(tree: Node[], key: string, children: Node[]): Node[] {
  if (key === "") {
    return children;
  }
  return tree.map((n) => {
    if (n.key === key) {
      return { ...n, children };
    }
    if (n.children) {
      return { ...n, children: insertChildren(n.children as Node[], key, children) };
    }
    return n;
  });
}

function mergeKeys(a: React.Key[], b: string[]): React.Key[] {
  const set = new Set<string>(a.map(String));
  for (const k of b) set.add(k);
  return Array.from(set);
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tree } from "antd";
import type { DataNode } from "antd/es/tree";
import { api, IndexEntry } from "../lib/api";
import type { Selection } from "../lib/selection";

/// antd's Tree.scrollTo isn't typed on the public ref in v5. Narrow handle
/// covers exactly what we use.
type TreeHandle = {
  scrollTo: (opts: { key: React.Key; align?: "top" | "bottom" | "auto"; offset?: number }) => void;
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
  storagePath?: string | null;
  size?: number;
};

function entryToNode(e: IndexEntry): Node {
  return {
    title: e.name,
    key: e.path,
    isLeaf: !e.is_dir,
    storagePath: e.storage_path,
    size: e.size,
  };
}

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
  const [height, setHeight] = useState(400);
  /// Dirs we've already fetched children for. Includes "" (root) once loaded.
  const loadedRef = useRef<Set<string>>(new Set());

  // Initial root load + reset on new storage.
  useEffect(() => {
    setData([]);
    setExpanded([]);
    setSelected([]);
    loadedRef.current = new Set();
    api
      .listDir("")
      .then((entries) => {
        setData(entries.map(entryToNode));
        loadedRef.current.add("");
      })
      .catch(() => setData([]));
  }, [generation]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch children for `key` and merge into the tree. Idempotent.
  const ensureLoaded = useCallback(async (key: string): Promise<void> => {
    if (loadedRef.current.has(key)) return;
    const children = await api.listDir(key);
    setData((prev) => insertChildren(prev, key, children.map(entryToNode)));
    loadedRef.current.add(key);
  }, []);

  // antd lazy-load: only fires when user expands a node whose children
  // haven't been populated yet.
  const loadData = useCallback(
    async (node: Node): Promise<void> => {
      await ensureLoaded(String(node.key));
    },
    [ensureLoaded]
  );

  // External navigation: walk to selection.path, loading ancestors as needed.
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
      // Don't auto-expand a file leaf — only its ancestors.
      const toExpand =
        selection.kind === "file" ? ancestors.slice(0, -1) : ancestors;
      setExpanded((prev) => mergeKeys(prev, toExpand));
      setSelected([selection.path]);
      // Two rAFs: first lets React commit the state change, second lets antd's
      // virtual list compute layout for the newly visible rows before scroll.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          (treeRef.current as TreeHandle | null)?.scrollTo({
            key: selection.path,
            align: "auto",
          });
        });
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selection, ensureLoaded]);

  return (
    <div ref={containerRef} style={{ height: "100%", width: "100%" }}>
      <Tree<Node>
        ref={treeRef}
        treeData={data}
        loadData={(n) => loadData(n as Node)}
        expandedKeys={expanded}
        onExpand={(keys) => setExpanded(keys)}
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
        showLine
        virtual
        height={height}
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

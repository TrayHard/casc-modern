import type { ItemType } from "antd/es/menu/interface";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import { message } from "antd";
import { api } from "./api";
import type { Selection } from "./selection";

export interface ContextActions {
  open: (s: Selection) => void;
  exportPath: (path: string) => Promise<void>;
  exportPathAsPng: (path: string) => Promise<void>;
  toggleBookmark: (target: Selection) => void;
}

interface BuildArgs {
  target: Selection;
  /** Whether the target is currently in the user's bookmarks. */
  isBookmarked: boolean;
}

function isSprite(path: string): boolean {
  return path.toLowerCase().endsWith(".sprite");
}

/// Build the antd Menu items list for either a file or a directory target.
/// Centralized so the tree, the directory view, and any other consumer pick
/// from the same set.
export function buildContextMenu({ target, isBookmarked }: BuildArgs): ItemType[] {
  const bookmarkItem: ItemType = {
    key: "bookmark",
    label: isBookmarked ? "Remove from bookmarks" : "Add to bookmarks",
  };
  if (target.kind === "file") {
    const items: ItemType[] = [
      { key: "open", label: "Open" },
      { key: "open-external", label: "Open externally…" },
      { type: "divider" },
      bookmarkItem,
      { type: "divider" },
      { key: "export", label: "Export file…" },
    ];
    if (isSprite(target.path)) {
      items.push({ key: "export-png", label: "Export as PNG…" });
    }
    items.push({ type: "divider" }, { key: "copy-path", label: "Copy path" });
    return items;
  }
  return [
    { key: "open", label: "Open" },
    { type: "divider" },
    bookmarkItem,
    { type: "divider" },
    { key: "export", label: "Export folder…" },
    { key: "export-png", label: "Export sprites here as PNG…" },
    { type: "divider" },
    { key: "copy-path", label: target.path ? "Copy path" : "Copy '<root>'" },
  ];
}

export async function handleContextAction(
  key: string,
  target: Selection,
  actions: ContextActions
) {
  switch (key) {
    case "open":
      actions.open(target);
      return;
    case "bookmark":
      actions.toggleBookmark(target);
      return;
    case "export":
      await actions.exportPath(target.path);
      return;
    case "export-png":
      await actions.exportPathAsPng(target.path);
      return;
    case "open-external":
      if (target.kind !== "file") return;
      try {
        const tmp = await api.extractToTemp(target.path);
        await openPath(tmp);
      } catch (e) {
        message.error(`Open failed: ${e}`);
      }
      return;
    case "copy-path":
      try {
        await writeText(target.path);
        message.success("Path copied");
      } catch (e) {
        message.error(`Clipboard failed: ${e}`);
      }
      return;
  }
}

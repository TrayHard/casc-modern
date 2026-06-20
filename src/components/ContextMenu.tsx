import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Menu } from "antd";
import type { ItemType } from "antd/es/menu/interface";

interface Props {
  x: number;
  y: number;
  items: ItemType[];
  onSelect: (key: string) => void;
  onClose: () => void;
}

/// A floating menu rendered at viewport coordinates via portal. Closes on any
/// outside mousedown or Esc. Used by the tree and the directory view for
/// right-click menus.
export function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 9999,
        boxShadow: "0 6px 16px rgba(0,0,0,0.6)",
        borderRadius: 4,
        overflow: "hidden",
        minWidth: 200,
      }}
    >
      <Menu
        items={items}
        onClick={({ key }) => {
          onSelect(String(key));
          onClose();
        }}
        style={{ border: 0, minWidth: 200 }}
        selectable={false}
      />
    </div>,
    document.body
  );
}

import { useMemo } from "react";

interface HexViewProps {
  bytes: number[];
  startOffset?: number;
}

const BYTES_PER_ROW = 16;

function toHex2(n: number) {
  return n.toString(16).padStart(2, "0");
}

function toHex8(n: number) {
  return n.toString(16).padStart(8, "0");
}

function asciiOf(b: number) {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
}

export function HexView({ bytes, startOffset = 0 }: HexViewProps) {
  const rows = useMemo(() => {
    const out: { offset: string; hex: string; ascii: string }[] = [];
    for (let i = 0; i < bytes.length; i += BYTES_PER_ROW) {
      const slice = bytes.slice(i, i + BYTES_PER_ROW);
      const hex = slice
        .map(toHex2)
        .reduce((acc, h, idx) => acc + (idx === 8 ? "  " : " ") + h, "")
        .trimStart();
      const padding = " ".repeat((BYTES_PER_ROW - slice.length) * 3);
      const ascii = slice.map(asciiOf).join("");
      out.push({
        offset: toHex8(startOffset + i),
        hex: hex + padding,
        ascii,
      });
    }
    return out;
  }, [bytes, startOffset]);

  return (
    <div
      style={{
        fontFamily: "Consolas, 'JetBrains Mono', monospace",
        fontSize: 12,
        lineHeight: "16px",
        whiteSpace: "pre",
        background: "#000",
        color: "#ddd",
        padding: 8,
        borderRadius: 4,
        overflow: "auto",
        height: "100%",
      }}
    >
      {rows.map((r, idx) => (
        <div key={idx}>
          <span style={{ color: "#666" }}>{r.offset}</span>
          <span style={{ color: "#aaffaa" }}>  {r.hex}  </span>
          <span style={{ color: "#ffcc99" }}>{r.ascii}</span>
        </div>
      ))}
    </div>
  );
}

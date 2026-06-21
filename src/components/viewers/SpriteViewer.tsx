import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Button,
  InputNumber,
  Popover,
  Result,
  Segmented,
  Slider,
  Space,
  Spin,
  message,
} from "antd";
import { api } from "../../lib/api";
import { base64PngToObjectUrl } from "../../lib/imageUrl";
import type { ViewerProps } from "./types";

interface SpriteImage {
  width: number;
  height: number;
  frame_count: number;
  frame_width: number;
  frame_height: number;
  png_b64: string;
}

/// Safety cap. Atlases above ~64 MP would take seconds to PNG-encode in Rust
/// and several megabytes of base64 over IPC; let the user save first.
const MAX_PIXELS = 8192 * 8192;

const CHECKER =
  "repeating-conic-gradient(#444 0% 25%, #222 0% 50%) 50% / 16px 16px";
const THUMB = 48;
const GAP = 6;

// A 32px-tall info pill so dimension/frame badges line up with the controls.
const PILL: CSSProperties = {
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 10px",
  borderRadius: 6,
  background: "rgba(255,255,255,0.06)",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};

export function SpriteViewer({ meta }: ViewerProps) {
  const [data, setData] = useState<SpriteImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [frame, setFrame] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Every sprite ships a high-quality `X.sprite` and a `X.lowend.sprite`; let
  // the user switch between them in place.
  const highPath = useMemo(
    () => meta.path.replace(/\.lowend\.sprite$/i, ".sprite"),
    [meta.path]
  );
  const lowPath = useMemo(
    () => highPath.replace(/\.sprite$/i, ".lowend.sprite"),
    [highPath]
  );
  const [quality, setQuality] = useState<"high" | "low">(() =>
    /\.lowend\.sprite$/i.test(meta.path) ? "low" : "high"
  );
  useEffect(() => {
    setQuality(/\.lowend\.sprite$/i.test(meta.path) ? "low" : "high");
  }, [meta.path]);
  const decodePath = quality === "low" ? lowPath : highPath;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setFrame(0);
    api
      .decodeSprite(decodePath)
      .then((d) => {
        if (cancelled) return;
        if (d.width * d.height > MAX_PIXELS) {
          setErr(
            `Atlas is ${d.width} × ${d.height} = ${(d.width * d.height).toLocaleString()} pixels — refusing to decode inline.`
          );
          return;
        }
        setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(String(e));
          message.error(`Sprite decode failed: ${e}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [decodePath]);

  // Track the thumbnail strip's width so we can show exactly one row and tuck
  // the rest behind a hover popover.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setStripWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Hold the atlas PNG as a Blob object URL (decoded once by the webview)
  // instead of a second multi-MB data: string; create before paint, revoke on
  // change. All frame thumbnails + the main image slice this one URL via CSS.
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!data) {
      setDataUrl(null);
      return;
    }
    const url = base64PngToObjectUrl(data.png_b64);
    setDataUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data]);

  // Measure the scroll container so we can fit the sprite to it.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Scale that fits the displayed frame inside the box (never upscales).
  const fitScale = useMemo(() => {
    if (!data || !box.w || !box.h) return 1;
    const w = data.frame_count > 1 ? data.frame_width : data.width;
    const h = data.frame_count > 1 ? data.frame_height : data.height;
    const s = Math.min((box.w - 24) / w, (box.h - 24) / h);
    return s > 0 ? Math.min(1, s) : 1;
  }, [data, box]);

  // The full frame grid for the "+N" overflow popover. Memoized so it isn't
  // rebuilt on every zoom-slider tick — only when the atlas, its URL, or the
  // selected frame changes. Always provided (never gated to null) so antd keeps
  // the popover trigger wired up and clicking "+N" actually opens it.
  const overflowGrid = useMemo(() => {
    if (!data || !dataUrl) return null;
    const fw = data.frame_width;
    const fh = data.frame_height;
    const ts = THUMB / Math.max(fw, fh);
    return (
      <div
        style={{
          maxWidth: 380,
          maxHeight: 320,
          overflow: "auto",
          display: "flex",
          flexWrap: "wrap",
          gap: GAP,
        }}
      >
        {Array.from({ length: data.frame_count }, (_, i) => (
          <div
            key={i}
            onClick={() => setFrame(i)}
            title={`Frame ${i}`}
            style={{
              flex: "0 0 auto",
              width: THUMB,
              height: THUMB,
              position: "relative",
              overflow: "hidden",
              cursor: "pointer",
              borderRadius: 3,
              background: CHECKER,
              outline: i === frame ? "2px solid #1677ff" : "1px solid #303030",
              outlineOffset: -1,
            }}
          >
            <img
              src={dataUrl}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                left: -i * fw * ts + (THUMB - fw * ts) / 2,
                top: (THUMB - fh * ts) / 2,
                width: data.width * ts,
                height: data.height * ts,
                imageRendering: "pixelated",
                pointerEvents: "none",
              }}
            />
          </div>
        ))}
      </div>
    );
  }, [data, dataUrl, frame]);

  if (err) {
    return <Result status="error" title="Cannot decode sprite" subTitle={err} />;
  }

  if (!data || !dataUrl) {
    return <Spin spinning={loading} />;
  }

  const multi = data.frame_count > 1;
  const fw = data.frame_width;
  const fh = data.frame_height;

  function thumb(i: number, size: number) {
    const ts = size / Math.max(fw, fh);
    return (
      <div
        key={i}
        onClick={() => setFrame(i)}
        title={`Frame ${i}`}
        style={{
          flex: "0 0 auto",
          width: size,
          height: size,
          position: "relative",
          overflow: "hidden",
          cursor: "pointer",
          borderRadius: 3,
          background: CHECKER,
          outline: i === frame ? "2px solid #1677ff" : "1px solid #303030",
          outlineOffset: -1,
        }}
      >
        <img
          src={dataUrl!}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            left: -i * fw * ts + (size - fw * ts) / 2,
            top: (size - fh * ts) / 2,
            width: data!.width * ts,
            height: data!.height * ts,
            imageRendering: "pixelated",
            pointerEvents: "none",
          }}
        />
      </div>
    );
  }

  // One row of thumbnails; whatever doesn't fit goes under the "+N" popover.
  const perThumb = THUMB + GAP;
  const allFit = data.frame_count * perThumb <= stripWidth;
  const maxInline = Math.max(
    1,
    Math.floor((stripWidth - (allFit ? 0 : perThumb)) / perThumb)
  );
  const visibleCount = Math.min(data.frame_count, maxInline);
  const overflow = data.frame_count - visibleCount;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Space wrap align="center" size={8}>
        <span style={PILL}>
          {data.width} × {data.height}
        </span>
        {multi && (
          <span style={{ ...PILL, color: "#69b1ff" }}>
            {data.frame_count} frames
          </span>
        )}
        <Segmented
          value={quality}
          onChange={(v) => setQuality(v as "high" | "low")}
          options={[
            { label: "High", value: "high" },
            { label: "Low", value: "low" },
          ]}
        />
        <span style={{ color: "#aaa" }}>Zoom</span>
        <Slider
          min={1}
          max={1600}
          step={5}
          value={Math.round(scale * 100)}
          onChange={(pct) => setScale(pct / 100)}
          tooltip={{ formatter: (v) => `${v}%` }}
          style={{ width: 160 }}
        />
        <InputNumber
          min={1}
          max={1600}
          step={5}
          value={Math.round(scale * 100)}
          onChange={(v) => setScale((Number(v) || 100) / 100)}
          formatter={(v) => `${v}%`}
          parser={(v) => Number((v ?? "").replace("%", "")) || 0}
          style={{ width: 96 }}
        />
        <Button onClick={() => setScale(fitScale)} title="Fit to window">
          Fit
        </Button>
        <Button onClick={() => setScale(1)} title="Original size (100%)">
          1:1
        </Button>
      </Space>

      {multi && (
        <div
          ref={stripRef}
          style={{
            display: "flex",
            gap: GAP,
            alignItems: "center",
            width: "100%",
            overflow: "hidden",
          }}
        >
          {Array.from({ length: visibleCount }, (_, i) => thumb(i, THUMB))}
          {overflow > 0 && (
            <Popover
              trigger="click"
              placement="bottomLeft"
              content={overflowGrid}
            >
              <div
                style={{
                  flex: "0 0 auto",
                  width: THUMB,
                  height: THUMB,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 3,
                  border: "1px dashed #666",
                  cursor: "pointer",
                  color: "#bbb",
                  fontSize: 12,
                }}
              >
                +{overflow}
              </div>
            </Popover>
          )}
        </div>
      )}

      <div
        ref={boxRef}
        style={{
          maxHeight: "calc(100vh - 420px)",
          overflow: "auto",
          padding: 4,
          alignSelf: "stretch",
        }}
      >
        {/* Inline-block wrapper sizes to its content so the checker-pattern
            background hugs the sprite instead of spanning the viewport. */}
        <div style={{ display: "inline-block", background: CHECKER }}>
          {multi ? (
            <div
              style={{
                width: fw * scale,
                height: fh * scale,
                overflow: "hidden",
                position: "relative",
              }}
            >
              <img
                src={dataUrl}
                alt={meta.path}
                style={{
                  position: "absolute",
                  left: -frame * fw * scale,
                  top: 0,
                  width: data.width * scale,
                  height: data.height * scale,
                  imageRendering: "pixelated",
                  pointerEvents: "none",
                }}
                draggable={false}
              />
            </div>
          ) : (
            <img
              src={dataUrl}
              alt={meta.path}
              style={{
                width: data.width * scale,
                height: data.height * scale,
                imageRendering: "pixelated",
                display: "block",
              }}
              draggable={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}

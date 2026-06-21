import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button, InputNumber, Result, Slider, Space, Spin, message } from "antd";
import { api, errMsg, RasterImage } from "../../lib/api";
import { base64PngToObjectUrl } from "../../lib/imageUrl";
import type { ViewerProps } from "./types";

const CHECKER =
  "repeating-conic-gradient(#444 0% 25%, #222 0% 50%) 50% / 16px 16px";
const PAD = 24; // scroll-container padding allowance for fit math

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

/// Generic raster-image viewer (.dds, .tga, .bmp, .png, .jpg). Decoded to PNG
/// in Rust (image / image_dds crates).
export function ImageViewer({ meta }: ViewerProps) {
  const [data, setData] = useState<RasterImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setScale(1);
    api
      .decodeImage(meta.path)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(errMsg(e));
          message.error(`Image decode failed: ${errMsg(e)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path]);

  // Measure the scroll container so we can fit the image to it.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  // Scale that makes the whole image fit inside the box (never upscales).
  const fitScale = useMemo(() => {
    if (!data || !box.w || !box.h) return 1;
    const s = Math.min((box.w - PAD) / data.width, (box.h - PAD) / data.height);
    return s > 0 ? Math.min(1, s) : 1;
  }, [data, box]);

  // Hold the decoded PNG as a Blob object URL rather than a second multi-MB
  // data: string; create before paint and revoke when the image changes.
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

  if (err) {
    const notLocal = /0x2|not found|CascOpenFile|GetFileSize/i.test(err);
    return (
      <Result
        status={notLocal ? "warning" : "error"}
        title={notLocal ? "File not available locally" : "Cannot decode image"}
        subTitle={
          notLocal
            ? "This file is indexed but its data isn't in the local storage (online-only or a different locale)."
            : err
        }
      />
    );
  }
  if (!data || !dataUrl) {
    return <Spin spinning={loading} />;
  }

  const pct = Math.round(scale * 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Space wrap align="center" size={8}>
        <span style={PILL}>
          {data.width} × {data.height}
        </span>
        <span style={{ color: "#aaa" }}>Zoom</span>
        <Slider
          min={1}
          max={1600}
          step={5}
          value={pct}
          onChange={(v) => setScale(v / 100)}
          tooltip={{ formatter: (v) => `${v}%` }}
          style={{ width: 160 }}
        />
        <InputNumber
          min={1}
          max={1600}
          step={5}
          value={pct}
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
      <div
        ref={boxRef}
        style={{
          maxHeight: "calc(100vh - 320px)",
          overflow: "auto",
          padding: 4,
          alignSelf: "stretch",
        }}
      >
        <div style={{ display: "inline-block", background: CHECKER }}>
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
        </div>
      </div>
    </div>
  );
}

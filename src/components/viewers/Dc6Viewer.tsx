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
  Result,
  Select,
  Slider,
  Space,
  Spin,
  message,
} from "antd";
import { ExportOutlined } from "@ant-design/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMsg, Dc6Image } from "../../lib/api";
import type { ViewerProps } from "./types";

const CHECKER =
  "repeating-conic-gradient(#444 0% 25%, #222 0% 50%) 50% / 16px 16px";
const THUMB = 48;
const GAP = 6;
const PAD = 24;

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

// Classic palettes shipped in the storage. DC6 stores indices only, so the
// palette choice decides the colors; "units" is the canonical default.
const PAL_BASE = "data/data/global/palette";
const PALETTES = [
  { label: "Units", path: `${PAL_BASE}/units/pal.dat` },
  { label: "Static", path: `${PAL_BASE}/static/pal.dat` },
  { label: "Loading", path: `${PAL_BASE}/loading/pal.dat` },
  { label: "Act 1", path: `${PAL_BASE}/act1/pal.dat` },
  { label: "Act 2", path: `${PAL_BASE}/act2/pal.dat` },
  { label: "Act 3", path: `${PAL_BASE}/act3/pal.dat` },
  { label: "Act 4", path: `${PAL_BASE}/act4/pal.dat` },
  { label: "Act 5", path: `${PAL_BASE}/act5/pal.dat` },
  { label: "Sky", path: `${PAL_BASE}/sky/pal.dat` },
  { label: "Menu", path: `${PAL_BASE}/menu0/pal.dat` },
  { label: "Fechar", path: `${PAL_BASE}/fechar/pal.dat` },
];

/// Viewer for classic Diablo II `.dc6` graphics (indexed; palette applied in
/// Rust). Steps through frames and lets the user switch palettes.
export function Dc6Viewer({ meta }: ViewerProps) {
  const [data, setData] = useState<Dc6Image | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [frame, setFrame] = useState(0);
  const [palette, setPalette] = useState(PALETTES[0].path);
  const [exporting, setExporting] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setFrame(0);
    api
      .decodeDc6(meta.path, palette)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setErr(errMsg(e));
          message.error(`DC6 decode failed: ${errMsg(e)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path, palette]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const urls = useMemo(
    () =>
      data ? data.frames.map((f) => `data:image/png;base64,${f.png_b64}`) : [],
    [data]
  );
  const cur = data && data.frames[frame] ? data.frames[frame] : null;

  const fitScale = useMemo(() => {
    if (!cur || !box.w || !box.h) return 1;
    const s = Math.min((box.w - PAD) / cur.width, (box.h - PAD) / cur.height);
    return s > 0 ? Math.min(1, s) : 1;
  }, [cur, box]);

  async function exportPng() {
    const dir = await openDialog({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setExporting(true);
    try {
      const r = await api.exportPathAsPng(meta.path, dir);
      message.success(`Exported ${r.files_written} PNG(s)`);
    } catch (e) {
      message.error(`Export failed: ${errMsg(e)}`);
    } finally {
      setExporting(false);
    }
  }

  if (err) {
    return <Result status="error" title="Cannot decode DC6" subTitle={err} />;
  }
  if (!data || !cur) {
    return <Spin spinning={loading} />;
  }

  const multi = data.frame_count > 1;
  const pct = Math.round(scale * 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Space wrap align="center" size={8}>
        <span style={PILL}>
          {cur.width} × {cur.height}
        </span>
        {multi && (
          <span style={{ ...PILL, color: "#69b1ff" }}>
            {data.frame_count} frames
            {data.directions > 1 ? ` · ${data.directions} dirs` : ""}
          </span>
        )}
        <span style={{ color: "#aaa" }}>Palette</span>
        <Select
          value={palette}
          onChange={setPalette}
          style={{ width: 130 }}
          options={PALETTES.map((p) => ({ value: p.path, label: p.label }))}
        />
        <span style={{ color: "#aaa" }}>Zoom</span>
        <Slider
          min={1}
          max={1600}
          step={5}
          value={pct}
          onChange={(v) => setScale(v / 100)}
          tooltip={{ formatter: (v) => `${v}%` }}
          style={{ width: 140 }}
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
        <Button onClick={() => setScale(fitScale)}>Fit</Button>
        <Button onClick={() => setScale(1)}>1:1</Button>
        <Button icon={<ExportOutlined />} loading={exporting} onClick={exportPng}>
          Export PNG…
        </Button>
      </Space>

      {multi && (
        <div style={{ display: "flex", gap: GAP, overflowX: "auto", paddingBottom: 4 }}>
          {data.frames.map((_f, i) => (
            <div
              key={i}
              onClick={() => setFrame(i)}
              title={`Frame ${i}`}
              style={{
                flex: "0 0 auto",
                width: THUMB,
                height: THUMB,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 3,
                background: CHECKER,
                cursor: "pointer",
                outline: i === frame ? "2px solid #1677ff" : "1px solid #303030",
                outlineOffset: -1,
              }}
            >
              <img
                src={urls[i]}
                alt=""
                draggable={false}
                style={{
                  maxWidth: THUMB - 4,
                  maxHeight: THUMB - 4,
                  imageRendering: "pixelated",
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div
        ref={boxRef}
        style={{
          maxHeight: "calc(100vh - 360px)",
          overflow: "auto",
          padding: 4,
          alignSelf: "stretch",
        }}
      >
        <div style={{ display: "inline-block", background: CHECKER }}>
          <img
            src={urls[frame]}
            alt={meta.path}
            style={{
              width: cur.width * scale,
              height: cur.height * scale,
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

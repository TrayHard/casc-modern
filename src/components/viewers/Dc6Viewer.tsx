import {
  memo,
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
import { api, errMsg, Dc6Info } from "../../lib/api";
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

// ---- Lazy per-frame loader -------------------------------------------------
// One frame is decoded + shipped at a time, keyed by path|palette|frame, so a
// 200-glyph font no longer ships every frame up front and a palette switch only
// refetches the frames actually on screen. Module-level cache survives remounts;
// concurrency is capped so scrolling a big strip doesn't flood the backend.
const frameCache = new Map<string, string>();
const frameInflight = new Map<string, Promise<string | null>>();
const MAX_DC6 = 4;
let dc6Active = 0;
const dc6Waiting: Array<() => void> = [];
function dc6Acquire(): Promise<void> {
  if (dc6Active < MAX_DC6) {
    dc6Active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    dc6Waiting.push(() => {
      dc6Active += 1;
      resolve();
    });
  });
}
function dc6Release(): void {
  dc6Active -= 1;
  dc6Waiting.shift()?.();
}
function frameKey(path: string, palette: string, frame: number): string {
  return `${path}|${palette}|${frame}`;
}
async function loadFrame(
  path: string,
  palette: string,
  frame: number
): Promise<string | null> {
  const key = frameKey(path, palette, frame);
  const cached = frameCache.get(key);
  if (cached) return cached;
  const existing = frameInflight.get(key);
  if (existing) return existing;
  const run = (async () => {
    await dc6Acquire();
    try {
      const f = await api.dc6Frame(path, palette, frame);
      const url = `data:image/png;base64,${f.png_b64}`;
      frameCache.set(key, url);
      return url;
    } catch {
      return null;
    } finally {
      dc6Release();
      frameInflight.delete(key);
    }
  })();
  frameInflight.set(key, run);
  return run;
}

// A frame thumbnail that only fetches its PNG once it scrolls into view.
const Dc6Thumb = memo(function Dc6Thumb({
  path,
  palette,
  frame,
  selected,
  onPick,
}: {
  path: string;
  palette: string;
  frame: number;
  selected: boolean;
  onPick: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(
    () => frameCache.get(frameKey(path, palette, frame)) ?? null
  );

  useEffect(() => {
    const cached = frameCache.get(frameKey(path, palette, frame));
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(null);
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadFrame(path, palette, frame).then((u) => {
            if (!cancelled) setUrl(u);
          });
        }
      },
      { rootMargin: "150px" }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [path, palette, frame]);

  return (
    <div
      ref={ref}
      onClick={() => onPick(frame)}
      title={`Frame ${frame}`}
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
        outline: selected ? "2px solid #1677ff" : "1px solid #303030",
        outlineOffset: -1,
      }}
    >
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            maxWidth: THUMB - 4,
            maxHeight: THUMB - 4,
            imageRendering: "pixelated",
          }}
        />
      )}
    </div>
  );
});

/// Viewer for classic Diablo II `.dc6` graphics (indexed; palette applied in
/// Rust). Steps through frames and lets the user switch palettes. Frames load
/// lazily so big fonts open instantly.
export function Dc6Viewer({ meta }: ViewerProps) {
  const [info, setInfo] = useState<Dc6Info | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [frame, setFrame] = useState(0);
  const [palette, setPalette] = useState(PALETTES[0].path);
  const [exporting, setExporting] = useState(false);
  const [mainUrl, setMainUrl] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Metadata is palette-independent — fetch it once per file.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setInfo(null);
    setFrame(0);
    api
      .dc6Info(meta.path)
      .then((d) => {
        if (!cancelled) setInfo(d);
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
  }, [meta.path]);

  // Load the displayed frame whenever it or the palette changes.
  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setMainUrl(frameCache.get(frameKey(meta.path, palette, frame)) ?? null);
    loadFrame(meta.path, palette, frame).then((u) => {
      if (!cancelled) setMainUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [info, meta.path, palette, frame]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [info]);

  const cur = info && info.frames[frame] ? info.frames[frame] : null;

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
  if (!info || !cur) {
    return <Spin spinning={loading} />;
  }

  const multi = info.frame_count > 1;
  const pct = Math.round(scale * 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Space wrap align="center" size={8}>
        <span style={PILL}>
          {cur.width} × {cur.height}
        </span>
        {multi && (
          <span style={{ ...PILL, color: "#69b1ff" }}>
            {info.frame_count} frames
            {info.directions > 1 ? ` · ${info.directions} dirs` : ""}
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
        <div
          style={{ display: "flex", gap: GAP, overflowX: "auto", paddingBottom: 4 }}
        >
          {Array.from({ length: info.frame_count }, (_, i) => (
            <Dc6Thumb
              key={i}
              path={meta.path}
              palette={palette}
              frame={i}
              selected={i === frame}
              onPick={setFrame}
            />
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
          {mainUrl ? (
            <img
              src={mainUrl}
              alt={meta.path}
              style={{
                width: cur.width * scale,
                height: cur.height * scale,
                imageRendering: "pixelated",
                display: "block",
              }}
              draggable={false}
            />
          ) : (
            <div
              style={{
                width: cur.width * scale,
                height: cur.height * scale,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Spin />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Alert, InputNumber, Result, Slider, Space, Spin, Tag, Typography, message } from "antd";
import { api } from "../../lib/api";
import type { ViewerProps } from "./types";

const { Text } = Typography;

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

export function SpriteViewer({ meta }: ViewerProps) {
  const [data, setData] = useState<SpriteImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(2);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setFrame(0);
    api
      .decodeSprite(meta.path)
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
  }, [meta.path]);

  const dataUrl = useMemo(
    () => (data ? `data:image/png;base64,${data.png_b64}` : null),
    [data]
  );

  if (err) {
    return <Result status="error" title="Cannot decode sprite" subTitle={err} />;
  }

  return (
    <Spin spinning={loading}>
      {data && dataUrl && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Space wrap>
            <Tag>{data.width} × {data.height}</Tag>
            {data.frame_count > 1 && (
              <Tag color="blue">{data.frame_count} frames</Tag>
            )}
            <Text type="secondary">
              frame size: {data.frame_width} × {data.frame_height}
            </Text>
            <span>Zoom:</span>
            <InputNumber
              min={1}
              max={16}
              value={scale}
              onChange={(v) => setScale(Number(v ?? 1))}
              addonAfter="×"
              style={{ width: 100 }}
            />
          </Space>
          {data.frame_count > 1 && (
            <Space style={{ width: "100%" }}>
              <Text>Frame:</Text>
              <Slider
                min={0}
                max={data.frame_count - 1}
                value={frame}
                onChange={setFrame}
                style={{ width: 280 }}
              />
              <Text code>{frame}</Text>
            </Space>
          )}
          <div
            style={{
              maxHeight: "calc(100vh - 420px)",
              overflow: "auto",
              border: "1px solid #303030",
              borderRadius: 4,
              padding: 12,
              alignSelf: "flex-start",
              maxWidth: "100%",
            }}
          >
            {/* Inline-block wrapper sizes to its content so the checker-pattern
                background hugs the sprite instead of spanning the viewport. */}
            <div
              style={{
                display: "inline-block",
                background:
                  "repeating-conic-gradient(#444 0% 25%, #222 0% 50%) 50% / 16px 16px",
              }}
            >
              {data.frame_count > 1 ? (
                <div
                  style={{
                    width: data.frame_width * scale,
                    height: data.frame_height * scale,
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <img
                    src={dataUrl}
                    alt={meta.path}
                    style={{
                      position: "absolute",
                      left: -frame * data.frame_width * scale,
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
          {data.frame_count > 1 && (
            <Alert
              type="info"
              showIcon
              message="Frames are stored as a horizontal strip. Each frame is independently displayable; full atlas is what the engine ships."
              style={{ marginTop: 4 }}
            />
          )}
        </div>
      )}
    </Spin>
  );
}

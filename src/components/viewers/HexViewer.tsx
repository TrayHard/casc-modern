import { useEffect, useState } from "react";
import { Spin, message } from "antd";
import { api } from "../../lib/api";
import { HexView } from "../HexView";
import type { ViewerProps } from "./types";

const PREVIEW_BYTES = 4096;

export function HexViewer({ meta }: ViewerProps) {
  const [bytes, setBytes] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .readFilePreview(meta.path, PREVIEW_BYTES)
      .then((p) => {
        if (!cancelled) setBytes(p.bytes);
      })
      .catch((e) => {
        if (!cancelled) {
          message.error(`Hex read failed: ${e}`);
          setBytes(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path]);

  return (
    <Spin spinning={loading} style={{ width: "100%" }}>
      {bytes ? (
        <div style={{ height: "calc(100vh - 320px)" }}>
          <HexView bytes={bytes} />
        </div>
      ) : null}
    </Spin>
  );
}

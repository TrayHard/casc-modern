import { useEffect, useState } from "react";
import { Button, Result, Space, Spin, message } from "antd";
import { ExportOutlined } from "@ant-design/icons";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, errMsg } from "../../lib/api";
import type { ViewerProps } from "./types";

const VIDEO_EXTS = new Set(["webm", "mp4", "ogv", "mkv", "avi", "mov"]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
}

/// Plays audio (.flac, .ogg, .wav, …) and video (.webm, .mp4, …) inline.
/// The file is extracted to the temp dir and streamed through Tauri's asset
/// protocol (range-request capable, so seeking works without loading the whole
/// file over IPC).
export function MediaViewer({ meta }: ViewerProps) {
  const isVideo = VIDEO_EXTS.has(extOf(meta.path));
  const [src, setSrc] = useState<string | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setSrc(null);
    setTemp(null);
    api
      .extractToTemp(meta.path)
      .then((t) => {
        if (cancelled) return;
        setTemp(t);
        setSrc(convertFileSrc(t));
      })
      .catch((e) => {
        if (!cancelled) setErr(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.path]);

  async function openExternally() {
    if (!temp) return;
    try {
      await openPath(temp);
    } catch (e) {
      message.error(`Open failed: ${errMsg(e)}`);
    }
  }

  if (err) {
    // CascLib 0x2 == file-not-found: the data isn't in the local storage. D2R
    // streams some videos / non-active locales on demand, so they're indexed
    // but not downloaded.
    const notLocal = /0x2|not found|CascOpenFile|GetFileSize/i.test(err);
    return (
      <Result
        status="warning"
        title={notLocal ? "File not available locally" : "Cannot load media"}
        subTitle={
          notLocal
            ? "This file isn't downloaded — D2R keeps some videos and other-locale assets online and fetches them on demand, so the data isn't in your local storage. Try a file from your own locale."
            : err
        }
      />
    );
  }

  return (
    <Spin spinning={loading}>
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Button
          icon={<ExportOutlined />}
          onClick={openExternally}
          disabled={!temp}
        >
          Open externally
        </Button>
        {src &&
          (isVideo ? (
            <video
              controls
              src={src}
              style={{
                maxWidth: "100%",
                maxHeight: "calc(100vh - 320px)",
                background: "#000",
                borderRadius: 4,
              }}
            />
          ) : (
            <audio controls src={src} style={{ width: "100%", minWidth: 320 }} />
          ))}
      </Space>
    </Spin>
  );
}

import { useEffect, useState } from "react";
import { Button, Modal, Progress, Tooltip, message } from "antd";
import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";

/// 20 minutes — slow enough not to hammer GitHub, frequent enough that
/// the user usually sees a fresh release within minutes of starting work.
const CHECK_INTERVAL_MS = 20 * 60 * 1000;

/// Public releases page. Used as the manual-download fallback for portable
/// users (whose running .exe lives outside Program Files and so can't be
/// silently replaced by the MSI installer the updater runs).
const RELEASES_URL = "https://github.com/TrayHard/casc-modern/releases/latest";

export function UpdateButton() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [pending, setPending] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState(0);

  useEffect(() => {
    api.isInstalled().then(setInstalled).catch(() => setInstalled(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const u = await check();
        if (cancelled) return;
        setPending(u?.available ? u : null);
      } catch (e) {
        // In dev mode the updater plugin throws — fine to swallow.
        if (!cancelled) console.warn("update check skipped:", e);
      }
    };
    ping();
    const id = setInterval(ping, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function install() {
    if (installing || !pending) return;
    setInstalling(true);
    setPercent(0);
    try {
      let downloaded = 0;
      let total = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) setPercent(Math.floor((downloaded / total) * 100));
        } else if (event.event === "Finished") {
          setPercent(100);
        }
      });
      await relaunch();
    } catch (e) {
      message.error(`Update failed: ${e}`);
      setInstalling(false);
    }
  }

  async function openReleases() {
    try {
      await openUrl(RELEASES_URL);
    } catch (e) {
      message.error(`Open failed: ${e}`);
    }
  }

  // Wait until we know the install mode before showing anything — avoids a
  // flicker between "manual download" and "in-app install".
  if (installed === null) return null;

  if (!pending) {
    return (
      <Tooltip title="Up to date" placement="bottom">
        <Button
          icon={<CheckCircleOutlined />}
          type="text"
          disabled
          style={{ color: "#888" }}
        />
      </Tooltip>
    );
  }

  // Portable .exe path: the updater would install the MSI alongside the
  // running portable binary and leave the user with two parallel copies.
  // Surface a button that just opens the releases page so they pick the
  // right artifact themselves.
  if (!installed) {
    return (
      <Tooltip
        title={`Update available (v${pending.version}). Portable build can't auto-update — click to download manually.`}
        placement="bottom"
      >
        <Button
          icon={<CloudDownloadOutlined />}
          onClick={openReleases}
        >
          Update available
        </Button>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip
        title={`Update available (v${pending.version}). Click to install.`}
        placement="bottom"
      >
        <Button
          type="primary"
          icon={installing ? <LoadingOutlined /> : <CloudDownloadOutlined />}
          onClick={install}
          disabled={installing}
        >
          Update
        </Button>
      </Tooltip>
      <Modal
        open={installing}
        title="Installing update…"
        footer={null}
        closable={false}
        maskClosable={false}
      >
        <Progress percent={percent} status="active" />
        <p style={{ marginTop: 12 }}>
          App will restart automatically when the install completes.
        </p>
      </Modal>
    </>
  );
}

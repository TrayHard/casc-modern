import { useEffect, useState } from "react";
import { message } from "antd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api, ExportProgress, ExportSummary, Settings } from "./api";

interface UseExporterResult {
  running: boolean;
  progress: ExportProgress | null;
  done: ExportSummary | null;
  /** Trigger the export flow for a virtual path (file or directory). */
  exportPath: (virtualPath: string) => Promise<void>;
  /** Convert every `.sprite` under `virtualPath` to PNG and export. */
  exportPathAsPng: (virtualPath: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Hide the "done" modal. */
  dismissDone: () => void;
}

/// Single source of truth for export state across the app. Wire one instance
/// in App, render the progress dialog there, and let context menus / buttons
/// call `exportPath`.
export function useExporter(
  settings: Settings | null,
  refreshSettings: () => void
): UseExporterResult {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [done, setDone] = useState<ExportSummary | null>(null);

  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];
    unlisteners.push(
      listen<ExportProgress>("export_progress", (e) => setProgress(e.payload))
    );
    unlisteners.push(
      listen<ExportSummary>("export_done", (e) => {
        setDone(e.payload);
        setRunning(false);
        setProgress(null);
      })
    );
    return () => {
      Promise.all(unlisteners).then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  async function runExport(
    _virtualPath: string,
    runner: (target: string) => Promise<ExportSummary>
  ) {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: settings?.last_export_dir ?? undefined,
    });
    if (typeof picked !== "string") return;
    setRunning(true);
    setDone(null);
    setProgress({
      current: 0,
      total: 0,
      current_path: "",
      bytes_written: 0,
      errors: 0,
    });
    try {
      await api.setLastExportDir(picked);
      refreshSettings();
      await runner(picked);
      // The export_done event resolves running/progress state.
    } catch (e) {
      message.error(`Export failed: ${e}`);
      setRunning(false);
      setProgress(null);
    }
  }

  function exportPath(virtualPath: string) {
    return runExport(virtualPath, (t) => api.exportPath(virtualPath, t));
  }

  function exportPathAsPng(virtualPath: string) {
    return runExport(virtualPath, (t) => api.exportPathAsPng(virtualPath, t));
  }

  async function cancel() {
    try {
      await api.cancelExport();
    } catch (e) {
      message.error(`Cancel failed: ${e}`);
    }
  }

  function dismissDone() {
    setDone(null);
  }

  return {
    running,
    progress,
    done,
    exportPath,
    exportPathAsPng,
    cancel,
    dismissDone,
  };
}

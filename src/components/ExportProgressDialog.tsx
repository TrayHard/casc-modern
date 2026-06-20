import { Alert, Button, Modal, Progress, Typography } from "antd";
import { StopOutlined } from "@ant-design/icons";
import { ExportProgress, ExportSummary, humanSize } from "../lib/api";

const { Text } = Typography;

interface Props {
  running: boolean;
  progress: ExportProgress | null;
  done: ExportSummary | null;
  onCancel: () => void;
  onDismiss: () => void;
}

/// Singleton dialog. Rendered once at App level; useExporter drives it.
export function ExportProgressDialog({ running, progress, done, onCancel, onDismiss }: Props) {
  return (
    <Modal
      open={running || done !== null}
      title={running ? "Exporting…" : "Export complete"}
      maskClosable={!running}
      onCancel={() => {
        if (running) return;
        onDismiss();
      }}
      footer={
        running
          ? [
              <Button key="cancel" danger icon={<StopOutlined />} onClick={onCancel}>
                Cancel
              </Button>,
            ]
          : [
              <Button key="ok" type="primary" onClick={onDismiss}>
                Close
              </Button>,
            ]
      }
      closable={!running}
    >
      {progress && (
        <Progress
          percent={
            progress.total === 0
              ? 0
              : Math.floor((progress.current * 100) / progress.total)
          }
          format={() => `${progress.current}/${progress.total}`}
          status={running ? "active" : "normal"}
        />
      )}
      {progress && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ wordBreak: "break-all" }}>
            {progress.current_path}
          </Text>
          <br />
          <Text type="secondary">
            {humanSize(progress.bytes_written)} written
            {progress.errors > 0 && ` · ${progress.errors} errors`}
          </Text>
        </div>
      )}
      {done && (
        <>
          <Alert
            type={done.cancelled ? "warning" : done.errors.length ? "warning" : "success"}
            showIcon
            message={
              done.cancelled
                ? "Cancelled"
                : `${done.files_written} files (${humanSize(done.bytes_written)}) in ${done.elapsed_ms} ms`
            }
            description={`→ ${done.target_dir}`}
            style={{ marginTop: 8 }}
          />
          {done.errors.length > 0 && (
            <Alert
              type="error"
              showIcon
              message={`${done.errors.length} errors`}
              description={
                <pre style={{ maxHeight: 180, overflow: "auto", margin: 0 }}>
                  {done.errors.slice(0, 20).join("\n")}
                  {done.errors.length > 20 && `\n…and ${done.errors.length - 20} more`}
                </pre>
              }
              style={{ marginTop: 8 }}
            />
          )}
        </>
      )}
    </Modal>
  );
}

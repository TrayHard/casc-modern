import { useState } from "react";
import { Button, Result, message } from "antd";
import { ExportOutlined } from "@ant-design/icons";
import { openPath } from "@tauri-apps/plugin-opener";
import { api, humanSize } from "../../lib/api";

interface Props {
  path: string;
  size: number;
  limit: number;
  /** What we'd have rendered if we'd loaded it (e.g. "JSON" / "text"). */
  kind: string;
}

/// Single source of truth for the "this file is too big — open externally"
/// flow. Used by JsonViewer, TextViewer, and anywhere else we hit a cap.
export function TooLargeNotice({ path, size, limit, kind }: Props) {
  const [opening, setOpening] = useState(false);

  async function openExternally() {
    setOpening(true);
    try {
      const temp = await api.extractToTemp(path);
      await openPath(temp);
    } catch (e) {
      message.error(`Open failed: ${e}`);
    } finally {
      setOpening(false);
    }
  }

  return (
    <Result
      status="warning"
      title={`File too large to format inline as ${kind}`}
      subTitle={`Size is ${humanSize(size)} — over the ${humanSize(
        limit
      )} cap. Inline rendering would freeze the UI; open it in your default editor instead.`}
      extra={
        <Button
          type="primary"
          icon={<ExportOutlined />}
          loading={opening}
          onClick={openExternally}
        >
          Open externally
        </Button>
      }
    />
  );
}

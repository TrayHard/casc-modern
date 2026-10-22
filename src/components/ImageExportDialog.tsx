import { useState } from "react";
import { Alert, InputNumber, Modal, Select, Slider, Space, Typography } from "antd";
import {
  IMAGE_FORMAT_OPTIONS,
  ImageExportFormat,
  usesQuality,
} from "../lib/imageExport";

const { Text } = Typography;

interface Props {
  paths: string[] | null;
  onCancel: () => void;
  onExport: (format: ImageExportFormat, quality: number) => void;
}

export function ImageExportDialog({ paths, onCancel, onExport }: Props) {
  const [format, setFormat] = useState<ImageExportFormat>("png");
  const [quality, setQuality] = useState(90);
  const lossy = usesQuality(format);

  return (
    <Modal
      open={paths !== null}
      title="Export graphics"
      okText="Choose destination…"
      onOk={() => onExport(format, quality)}
      onCancel={onCancel}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {paths && paths.length > 1 ? (
          <div>
            <Text type="secondary">{paths.length} selected items</Text>
            {paths.slice(0, 3).map((path) => (
              <div key={path}>
                <Text code style={{ wordBreak: "break-all" }}>{path}</Text>
              </div>
            ))}
            {paths.length > 3 && <Text type="secondary">and {paths.length - 3} more…</Text>}
          </div>
        ) : (
          <Text code style={{ wordBreak: "break-all" }}>
            {paths?.[0] || "<storage root>"}
          </Text>
        )}
        <div>
          <Text type="secondary">Format</Text>
          <Select
            aria-label="Image format"
            value={format}
            options={IMAGE_FORMAT_OPTIONS}
            onChange={setFormat}
            style={{ width: "100%", marginTop: 6 }}
          />
        </div>
        <div>
          <Text type="secondary">Quality</Text>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Slider
              aria-label="Image quality"
              min={0}
              max={100}
              value={quality}
              disabled={!lossy}
              onChange={setQuality}
              style={{ flex: 1 }}
            />
            <InputNumber
              aria-label="Image quality percentage"
              min={0}
              max={100}
              value={quality}
              disabled={!lossy}
              formatter={(value) => `${value}%`}
              parser={(value) => Number(value?.replace("%", "") || 0)}
              onChange={(value) => setQuality(value ?? 0)}
              style={{ width: 80 }}
            />
          </div>
          {!lossy && <Text type="secondary">This format is lossless. Quality does not apply.</Text>}
        </div>
        {format === "jpeg" && (
          <Alert
            type="info"
            showIcon
            message="JPEG has no transparency. Transparent areas become black."
          />
        )}
      </Space>
    </Modal>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Drawer,
  InputNumber,
  Select,
  Space,
  Switch,
  Tabs,
  Typography,
  message,
} from "antd";
import {
  CloseOutlined,
  ImportOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMsg, type Preferences } from "../lib/api";
import { themeNames, validateIconThemeJson } from "../lib/fileIcons";

const { Text, Title } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  preferences: Preferences;
  /** Called after a successful save so App reloads settings into context. */
  onSaved: () => void;
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 0",
        borderBottom: "1px solid #262626",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div>{label}</div>
        {hint && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {hint}
          </Text>
        )}
      </div>
      <div style={{ flex: "0 0 auto" }}>{children}</div>
    </div>
  );
}

/// App settings. Changes apply (and persist) immediately so their effect is
/// visible live in the tree / viewers.
export function SettingsDrawer({ open, onClose, preferences, onSaved }: Props) {
  const [prefs, setPrefs] = useState<Preferences>(preferences);

  useEffect(() => {
    if (open) setPrefs(preferences);
  }, [open, preferences]);

  const apply = useCallback(
    async (next: Preferences) => {
      setPrefs(next);
      try {
        await api.setPreferences(next);
        onSaved();
      } catch (e) {
        message.error(`Save failed: ${errMsg(e)}`);
      }
    },
    [onSaved]
  );

  function set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    apply({ ...prefs, [key]: value });
  }

  const importTheme = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      filters: [{ name: "Icon theme", extensions: ["json"] }],
    });
    if (typeof picked !== "string") return;
    let text: string;
    try {
      text = await api.readTextFile(picked);
    } catch (e) {
      message.error(`Read failed: ${errMsg(e)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      message.error("That file isn't valid JSON.");
      return;
    }
    const theme = validateIconThemeJson(parsed);
    if (!theme) {
      message.error('Not a valid icon theme (it needs at least a "name").');
      return;
    }
    const custom = [
      ...prefs.custom_icon_themes.filter((t) => t.name !== theme.name),
      theme,
    ];
    apply({ ...prefs, custom_icon_themes: custom, icon_theme: theme.name });
    message.success(`Imported icon theme "${theme.name}".`);
  }, [prefs, apply]);

  const mb = prefs.json_external_threshold_bytes / (1024 * 1024);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <Space>
          <SettingOutlined /> Settings
        </Space>
      }
      width={520}
      closable={false}
      extra={<Button icon={<CloseOutlined />} onClick={onClose} />}
    >
      <Tabs
        defaultActiveKey="general"
        items={[
          {
            key: "general",
            label: "General",
            children: (
              <>
                <Title level={5}>Thumbnails</Title>
                <SettingRow
                  label="Image previews in the tree"
                  hint="Off = format icons only (faster)."
                >
                  <Switch
                    checked={prefs.thumbnails_in_tree}
                    onChange={(v) => set("thumbnails_in_tree", v)}
                  />
                </SettingRow>
                <SettingRow
                  label="Image previews in the browser"
                  hint="The right-hand directory list."
                >
                  <Switch
                    checked={prefs.thumbnails_in_browser}
                    onChange={(v) => set("thumbnails_in_browser", v)}
                  />
                </SettingRow>

                <Title level={5} style={{ marginTop: 20 }}>
                  Files
                </Title>
                <SettingRow
                  label="Hide other locales"
                  hint="Hide files/folders that aren't for the storage's installed locale."
                >
                  <Switch
                    checked={prefs.hide_other_locales}
                    onChange={(v) => set("hide_other_locales", v)}
                  />
                </SettingRow>
                <SettingRow
                  label="Hide low-quality sprites"
                  hint="Hide *.lowend.sprite variants; the viewer can still switch quality."
                >
                  <Switch
                    checked={prefs.hide_lowend}
                    onChange={(v) => set("hide_lowend", v)}
                  />
                </SettingRow>

                <Title level={5} style={{ marginTop: 20 }}>
                  Icon theme
                </Title>
                <SettingRow label="Theme" hint="Palette for format / folder icons.">
                  <Select
                    value={prefs.icon_theme}
                    style={{ width: 220 }}
                    onChange={(v) => set("icon_theme", v)}
                    options={themeNames(prefs.custom_icon_themes).map((n) => ({
                      value: n,
                      label: n,
                    }))}
                  />
                </SettingRow>
                <div style={{ paddingTop: 12 }}>
                  <Button icon={<ImportOutlined />} onClick={importTheme}>
                    Import theme…
                  </Button>
                  <Text
                    type="secondary"
                    style={{ display: "block", marginTop: 8, fontSize: 12 }}
                  >
                    A theme is a JSON file with a <code>name</code> plus optional{" "}
                    <code>folder</code>, <code>file</code>, and a{" "}
                    <code>byExt</code> map of extension → {"{ icon, color }"}.
                    Glyph keys: file, folder, image, audio, video, code, text,
                    palette, font, data.
                  </Text>
                </div>
              </>
            ),
          },
          {
            key: "performance",
            label: "Performance",
            children: (
              <>
                <SettingRow
                  label="Open JSON / text externally above"
                  hint="Bigger files prompt to open in an external app instead of loading inline. 0 = always inline."
                >
                  <Space>
                    <InputNumber
                      min={0}
                      max={1024}
                      step={0.5}
                      value={Number(mb.toFixed(2))}
                      onChange={(v) =>
                        set(
                          "json_external_threshold_bytes",
                          Math.round((Number(v) || 0) * 1024 * 1024)
                        )
                      }
                      style={{ width: 96 }}
                    />
                    <Text type="secondary">MB</Text>
                  </Space>
                </SettingRow>
                <SettingRow
                  label="Table overscan"
                  hint="Extra rows/columns the table grid renders beyond the viewport — higher means fewer blank flashes while fast-scrolling, at some cost."
                >
                  <InputNumber
                    min={0}
                    max={64}
                    step={1}
                    value={prefs.table_overscan}
                    onChange={(v) =>
                      set("table_overscan", Math.round(Number(v) || 0))
                    }
                    style={{ width: 96 }}
                  />
                </SettingRow>
              </>
            ),
          },
        ]}
      />
    </Drawer>
  );
}

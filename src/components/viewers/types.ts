import type { FC } from "react";
import type { FileMeta } from "../../lib/api";

export interface ViewerProps {
  meta: FileMeta;
}

export interface Viewer {
  /** Tab key — also stable id used in tests. */
  id: string;
  /** Tab label. */
  label: string;
  /** Should this viewer appear for this file? */
  matches: (meta: FileMeta) => boolean;
  /** Body of the tab. Owns its own data fetching. */
  Component: FC<ViewerProps>;
}

/// Right-panel content is always either nothing, a directory, or a file.
/// Centralizing the discriminated union here avoids stringly-typed branches
/// scattered through the App.
export type Selection =
  | { kind: "dir"; path: string }
  | { kind: "file"; path: string };

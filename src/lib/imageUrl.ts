/// Turn a base64-encoded PNG into a Blob object URL. Avoids holding a second
/// multi-MB `data:` string alongside the base64 in memory, and lets the webview
/// decode the PNG once. The caller owns the URL and must revoke it when the
/// source changes or the component unmounts.
export function base64PngToObjectUrl(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

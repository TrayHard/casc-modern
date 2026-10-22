export type ImageExportFormat = "png" | "webp" | "webp-lossless" | "jpeg" | "avif";

export const IMAGE_FORMAT_OPTIONS: { value: ImageExportFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "webp", label: "WebP" },
  { value: "webp-lossless", label: "WebP (lossless)" },
  { value: "jpeg", label: "JPEG" },
  { value: "avif", label: "AVIF" },
];

export function isConvertibleImage(path: string): boolean {
  return /\.(sprite|dc6|png|jpe?g|bmp|tga)$/i.test(path);
}

export function usesQuality(format: ImageExportFormat): boolean {
  return format === "webp" || format === "jpeg" || format === "avif";
}

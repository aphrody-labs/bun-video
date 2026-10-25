export interface PixelSVG {
  svg: string;
  width: number;
  height: number;
  pixels: number;
  colors: number;
  runs: number;
}

/** Preserve every RGBA colour as solid vector paths at the reference pixel grid. */
export function rgbaToPixelSVG(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  title = "Référence pixel",
): PixelSVG {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 256 ||
    height > 256 ||
    pixels.length !== width * height * 4
  )
    throw new RangeError("Pixel SVG requires an exact RGBA grid of 1..256 pixels per dimension");
  const groups = new Map<number, string[]>();
  const colorAt = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return (
      ((pixels[offset]! << 24) | (pixels[offset + 1]! << 16) | (pixels[offset + 2]! << 8) | pixels[offset + 3]!) >>> 0
    );
  };
  let runs = 0;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const color = colorAt(x, y);
      let end = x + 1;
      while (end < width && colorAt(end, y) === color) end++;
      let paths = groups.get(color);
      if (!paths) {
        paths = [];
        groups.set(color, paths);
      }
      paths.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      runs++;
      x = end;
    }
  }
  const escape = (text: string) =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  const paths = [...groups]
    .map(([rgba, runs]) => {
      const rgb = (rgba >>> 8).toString(16).padStart(6, "0");
      const alpha = rgba & 255;
      return `<path fill="#${rgb}"${alpha === 255 ? "" : ` fill-opacity="${alpha / 255}"`} d="${runs.join("")}"/>`;
    })
    .join("");
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><title>${escape(title)}</title>${paths}</svg>`,
    width,
    height,
    pixels: width * height,
    colors: groups.size,
    runs,
  };
}

import { decodePngToRgba } from "./png-decode";

interface ImageLike {
  png(options?: Record<string, unknown>): { bytes(): Promise<Uint8Array> };
}

/**
 * Unmodified Bun.Image has no raw-pixel terminal (the Bun fork added `rgba()`). This shim adds a
 * pure-TypeScript `rgba()` built on the documented `png().bytes()` terminal and is a no-op when the
 * runtime already provides one. It never replaces an existing method.
 */
export function installImageRgba(): void {
  const prototype = (globalThis as unknown as { Bun?: { Image?: { prototype: Record<string, unknown> } } }).Bun?.Image?.prototype;
  if (!prototype || typeof prototype.rgba === "function") return;
  Object.defineProperty(prototype, "rgba", {
    configurable: true,
    writable: true,
    value: async function rgba(this: ImageLike) {
      return decodePngToRgba(await this.png().bytes());
    },
  });
}

installImageRgba();

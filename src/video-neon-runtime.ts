import { dirname, isAbsolute, join } from "node:path";
import { VideoCatalog, defaultVideoCatalogPath } from "./video-catalog";
import { NeonVideoCatalog } from "./video-neon-catalog";

const mainHost = "ep-lucky-star-b97hoksf.c-7.eu-central-1.aws.neon.tech";

/** Resolve one canonical backend; a cutover marker prevents silent SQLite recreation. */
export async function openConfiguredVideoCatalog(
  options: {
    sqlitePath?: string;
    connectionFile?: string;
    cutoverMarker?: string;
  } = {},
): Promise<VideoCatalog | NeonVideoCatalog> {
  const home = dirname(dirname(dirname(defaultVideoCatalogPath())));
  const marker = options.cutoverMarker ?? join(home, "config", "bun-video-neon.active");
  const connectionFile = options.connectionFile ?? join(home, "config", "bun-video-neon.url");
  if (![marker, connectionFile].every(path => isAbsolute(path) && !path.includes("\0")))
    throw new TypeError("Private Neon configuration paths must be absolute");
  const activated = await Bun.file(marker).exists();
  const selected = Bun.env.BUN_VIDEO_CATALOG_BACKEND;
  if (selected !== undefined && selected !== "sqlite" && selected !== "neon")
    throw new TypeError("Unknown Bun Video catalog backend");
  if (activated && selected === "sqlite") throw new Error("Bun Video Neon cutover forbids SQLite writers");
  if (selected !== "neon" && !activated) return new VideoCatalog(options.sqlitePath);
  if (options.sqlitePath) throw new TypeError("Neon mode refuses a SQLite catalog path");
  const file = Bun.file(connectionFile);
  if (!(await file.exists()) || file.size > 4096)
    throw new Error("Private Neon connection file is missing or oversized");
  const connectionString = (await file.text()).trim();
  let createNeonClient: typeof import("@aphrody/bun-plugin-neon").createNeonClient;
  try {
    ({ createNeonClient } = await import("@aphrody/bun-plugin-neon"));
  } catch {
    throw new Error("The Neon catalog requires the optional @aphrody/bun-plugin-neon package");
  }
  const sql = createNeonClient({
    connectionString,
    expectedHostname: mainHost,
    expectedDatabase: "bun_video",
    requireDirect: true,
  });
  try {
    return await NeonVideoCatalog.open(sql);
  } catch (error) {
    await sql.close();
    throw error;
  }
}

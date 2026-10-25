#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
import { lstat, readlink, symlink, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { loadJsonSecret, saveJsonSecret, type JsonSecretStore } from "../secrets";
import { parseCookieBundle } from "./hls-live-core";

const root = resolve(process.cwd());
export const COOKIE_SECRET = { service: "@aphrody/bun-video", name: "crunchyroll.cookies" };

export async function migrateCookieInput(source: string, store?: JsonSecretStore) {
  if (!isAbsolute(source)) throw new Error("Cookie source must use an absolute path.");
  let raw;
  try {
    raw = await Bun.file(source).json();
  } catch {
    throw new Error("Cookie source cannot be read.");
  }
  const bundle = parseCookieBundle(raw);
  for (const cookie of bundle.chromium) {
    const host = (cookie.domain ?? new URL(cookie.url!).hostname).replace(/^\./, "").toLowerCase();
    if (host !== "crunchyroll.com" && !host.endsWith(".crunchyroll.com"))
      throw new Error("This migration accepts Crunchyroll cookies only.");
  }
  const existing = await loadJsonSecret(COOKIE_SECRET, store);
  if (existing !== null) {
    if (JSON.stringify(parseCookieBundle(existing)) !== JSON.stringify(bundle))
      throw new Error("A different Crunchyroll credential already exists; it was preserved.");
  } else {
    await saveJsonSecret(COOKIE_SECRET, bundle, store);
  }
  const loaded = parseCookieBundle(await loadJsonSecret(COOKIE_SECRET, store));
  if (JSON.stringify(loaded) !== JSON.stringify(bundle))
    throw new Error("The credential could not be verified after storage.");
  return {
    provider: "bun.secrets",
    ...COOKIE_SECRET,
    cookieCount: loaded.chromium.length,
    verified: true,
    originalPreserved: true,
  };
}

export async function configureLabKeychain() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) throw new Error("The owner credential directory is unavailable.");
  const cookieLink = resolve(root, "cookie.json");
  const referenceFile = resolve(home, ".aphrody/cookies/bun-video/cookie-reference.json");
  const metadata = { provider: "bun.secrets", ...COOKIE_SECRET };
  if (!(await lstat(cookieLink)).isSymbolicLink())
    throw new Error("Lab cookie input is not a symlink; its contents were preserved.");
  if (await Bun.file(referenceFile).exists()) {
    let existing;
    try {
      existing = await Bun.file(referenceFile).json();
    } catch {
      throw new Error("Existing credential reference is unreadable and was preserved.");
    }
    if (JSON.stringify(existing) !== JSON.stringify(metadata))
      throw new Error("A different credential reference exists and was preserved.");
  } else {
    await Bun.write(referenceFile, JSON.stringify(metadata, null, 2) + "\n");
  }
  const previousTarget = await readlink(cookieLink);
  if (resolve(root, previousTarget) === referenceFile) return;
  await unlink(cookieLink);
  try {
    await symlink(referenceFile, cookieLink, "file");
  } catch {
    await symlink(previousTarget, cookieLink, "file");
    throw new Error("Lab credential reference could not be activated; the original link was restored.");
  }
}

export async function main(args = Bun.argv.slice(2)) {
  if (!args.includes("--migrate") && !args.includes("--check")) {
    console.log(
      "bun-video keychain --migrate --source <absolute protected cookie.json> [--configure-lab]\nbun-video keychain --check\nReads/writes only the owned Crunchyroll credential; no browser database extraction or secret output.",
    );
  } else if (args.includes("--check")) {
    const secret = await loadJsonSecret(COOKIE_SECRET);
    const bundle = secret === null ? null : parseCookieBundle(secret);
    console.log(
      JSON.stringify({
        provider: "bun.secrets",
        present: bundle !== null,
        cookieCount: bundle?.chromium.length ?? 0,
        livePlaybackValidated: false,
      }),
    );
  } else {
    const sourceIndex = args.indexOf("--source");
    const source = args[sourceIndex + 1];
    if (sourceIndex < 0 || !source) throw new Error("--source requires an absolute protected cookie path.");
    const result = await migrateCookieInput(source);
    if (args.includes("--configure-lab")) await configureLabKeychain();
    console.log(
      JSON.stringify({
        ...result,
        labConfigured: args.includes("--configure-lab"),
        livePlaybackValidated: false,
      }),
    );
  }
}

if (import.meta.main)
  main().catch(() => {
    console.error("Video lab failed; check private inputs and options. Captured values are omitted.");
    process.exitCode = 1;
  });

/** Unified `bun-video` subcommand entry. */
export const run: (args: string[]) => Promise<void> = main;

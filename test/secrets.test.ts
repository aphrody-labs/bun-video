import { expect, test } from "bun:test";
import {
  JsonSecretError,
  loadJsonSecret,
  saveJsonSecret,
  type JsonSecretStore,
  type SecretReference,
} from "../src/secrets";

const ref = { service: "@aphrody/bun-video", name: "crunchyroll.cookies" };
const key = (reference: SecretReference) => `${reference.service}\0${reference.name}`;

function memoryStore() {
  const values = new Map<string, string>();
  const writes: (SecretReference & { value: string; persist: "local" })[] = [];
  const deletes: SecretReference[] = [];
  const store: JsonSecretStore = {
    async get(reference) {
      return values.get(key(reference)) ?? null;
    },
    async set(reference) {
      writes.push({ ...reference });
      values.set(key(reference), reference.value);
    },
    async delete(reference) {
      deletes.push({ ...reference });
      return values.delete(key(reference));
    },
  };
  return { store, values, writes, deletes };
}

test("small OAuth JSON stays in native local credentials without plaintext files", async () => {
  const memory = memoryStore();
  const config = {
    clientId: "local-client",
    clientSecret: "local-secret",
    endpoints: { token: "https://provider.example/token" },
  };
  expect(await loadJsonSecret(ref, memory.store)).toBeNull();
  const metadata = await saveJsonSecret(ref, config, memory.store);
  expect(metadata).toEqual({
    format: "json",
    bytes: new TextEncoder().encode(JSON.stringify(config)).length,
    chunks: 0,
  });
  expect(memory.writes).toHaveLength(1);
  expect(memory.writes[0]!.persist).toBe("local");
  expect(await loadJsonSecret(ref, memory.store)).toEqual(config);
  expect(JSON.stringify(metadata)).not.toContain("local-secret");
  await expect(saveJsonSecret(ref, { replacement: true }, memory.store)).rejects.toThrow("overwrite is refused");
  expect(await loadJsonSecret(ref, memory.store)).toEqual(config);
  expect(memory.deletes).toHaveLength(0);
});

test("large Unicode JSON roundtrips across byte boundaries with bounded credentials and final manifest", async () => {
  const memory = memoryStore();
  const value = { cookies: [{ domain: ".example.test", value: "é日本語🍪".repeat(900) }] };
  const metadata = await saveJsonSecret(ref, value, memory.store);
  expect(metadata.format).toBe("chunked-json");
  expect(metadata.bytes).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  expect(metadata.bytes).toBeGreaterThan(10_801);
  expect(memory.writes.length).toBe(metadata.chunks + 1);
  const root = memory.writes.at(-1)!;
  expect(root.name).toBe(ref.name);
  const manifest = JSON.parse(root.value);
  expect(manifest.generation).toMatch(/^[a-f0-9-]{36}$/);
  expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.bytes).toBe(metadata.bytes);
  expect(manifest.chunks).toBe(metadata.chunks);
  for (const credential of memory.writes) {
    expect(credential.service).toBe(ref.service);
    expect(credential.persist).toBe("local");
    expect(new TextEncoder().encode(credential.value).length).toBeLessThanOrEqual(2400);
  }
  for (const part of memory.writes.slice(0, -1)) {
    expect(part.name).toStartWith(`${ref.name}.part.${manifest.generation}.`);
    expect(typeof JSON.parse(part.value)).toBe("string");
  }
  expect(await loadJsonSecret(ref, memory.store)).toEqual(value);
});

test("tampered content, missing parts, malformed base64 and manifest size attacks fail before returning secrets", async () => {
  for (const mutation of ["content", "missing", "encoding", "size", "generation", "extra", "checksum"] as const) {
    const memory = memoryStore();
    await saveJsonSecret(ref, { secret: "private-fixture".repeat(700) }, memory.store);
    const first = memory.writes[0]!;
    const root = memory.writes.at(-1)!;
    if (mutation === "missing") memory.values.delete(key(first));
    else if (mutation === "encoding") memory.values.set(key(first), JSON.stringify("%%%private-fixture"));
    else if (mutation === "content") {
      const encoded = JSON.parse(first.value) as string;
      memory.values.set(key(first), JSON.stringify((encoded[0] === "A" ? "B" : "A") + encoded.slice(1)));
    } else {
      const manifest = JSON.parse(root.value);
      if (mutation === "size") {
        manifest.bytes = Number.MAX_SAFE_INTEGER;
        manifest.chunks = Number.MAX_SAFE_INTEGER;
      }
      if (mutation === "generation") manifest.generation = "../../another-profile";
      if (mutation === "extra") manifest.parts = ["another-secret"];
      if (mutation === "checksum") manifest.sha256 = "0".repeat(64);
      memory.values.set(key(ref), JSON.stringify(manifest));
    }
    try {
      await loadJsonSecret(ref, memory.store);
      throw new Error("Expected bounded secret failure");
    } catch (error) {
      expect(error).toBeInstanceOf(JsonSecretError);
      expect((error as Error).message).not.toContain("private-fixture");
    }
  }
});

test("partial part write failure rolls back only generated entries and preserves unrelated secrets", async () => {
  const memory = memoryStore();
  memory.values.set(key({ ...ref, name: "unrelated" }), "protected-original");
  const originalSet = memory.store.set;
  let attempts = 0;
  memory.store.set = async reference => {
    await originalSet(reference);
    if (++attempts === 2) throw new Error("private-provider-error");
  };
  await expect(saveJsonSecret(ref, { secret: "private-value".repeat(600) }, memory.store)).rejects.toThrow(
    "Secret credential write failed",
  );
  expect(memory.deletes).toHaveLength(2);
  expect(memory.values.size).toBe(1);
  expect(memory.values.get(key({ ...ref, name: "unrelated" }))).toBe("protected-original");
  expect(memory.writes.some(write => write.name === ref.name)).toBe(false);
});

test("manifest write acknowledgement failure removes an owned root plus parts", async () => {
  const memory = memoryStore();
  const originalSet = memory.store.set;
  memory.store.set = async reference => {
    await originalSet(reference);
    if (reference.name === ref.name) throw new Error("private-root-failure");
  };
  await expect(saveJsonSecret(ref, { secret: "local".repeat(900) }, memory.store)).rejects.toThrow(
    "Secret credential write failed",
  );
  expect(memory.values.size).toBe(0);
  expect(memory.deletes[0]!.name).toBe(ref.name);
});

test("concurrent root creation is preserved and newly written parts are rolled back", async () => {
  const memory = memoryStore();
  const originalGet = memory.store.get;
  let rootReads = 0;
  memory.store.get = async reference => {
    if (reference.name === ref.name && ++rootReads === 2)
      memory.values.set(key(ref), JSON.stringify({ protected: true }));
    return originalGet(reference);
  };
  await expect(saveJsonSecret(ref, { secret: "local".repeat(900) }, memory.store)).rejects.toThrow(
    "created concurrently",
  );
  expect(memory.values.size).toBe(1);
  expect(await loadJsonSecret(ref, memory.store)).toEqual({ protected: true });
  expect(memory.deletes.every(entry => entry.name !== ref.name)).toBe(true);
});

test("rollback preserves a part replaced by another writer and reports cleanup failures safely", async () => {
  const memory = memoryStore();
  const originalSet = memory.store.set;
  let writes = 0;
  memory.store.set = async reference => {
    await originalSet(reference);
    if (++writes === 2) {
      memory.values.set(key(memory.writes[0]!), "foreign-writer-value");
      throw new Error("private-write-error");
    }
  };
  await expect(saveJsonSecret(ref, { secret: "local".repeat(900) }, memory.store)).rejects.toThrow(
    "Secret credential write failed",
  );
  expect(memory.values.size).toBe(1);
  expect(memory.values.get(key(memory.writes[0]!))).toBe("foreign-writer-value");
  const failing = memoryStore();
  failing.store.set = async reference => {
    failing.values.set(key(reference), reference.value);
    throw new Error("private-write-error");
  };
  failing.store.delete = async () => {
    throw new Error("private-delete-error");
  };
  await expect(saveJsonSecret(ref, { secret: "local" }, failing.store)).rejects.toThrow(
    "owned rollback was incomplete",
  );
});

test("invalid direct JSON and provider errors remain redacted", async () => {
  const memory = memoryStore();
  memory.values.set(key(ref), "private-invalid-json");
  await expect(loadJsonSecret(ref, memory.store)).rejects.toThrow("contains invalid JSON");
  memory.store.get = async () => {
    throw new Error("private-provider-secret");
  };
  await expect(loadJsonSecret(ref, memory.store)).rejects.toThrow("Secret credential read failed");
  await expect(saveJsonSecret(ref, { secret: "local" }, memory.store)).rejects.toThrow(
    "Secret credential write failed",
  );
});

test("unsafe references, reserved manifests, unserializable and oversized values fail before native writes", async () => {
  const memory = memoryStore();
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const value of [undefined, cyclic, 1n])
    await expect(saveJsonSecret(ref, value, memory.store)).rejects.toThrow("JSON serializable");
  for (const value of [
    { $bunVideoSecret: "private-marker" },
    { toJSON: () => ({ $bunVideoSecret: "private-marker" }) },
  ])
    await expect(saveJsonSecret(ref, value, memory.store)).rejects.toThrow("reserved storage marker");
  await expect(saveJsonSecret(ref, { secret: "x".repeat(1024 * 1024) }, memory.store)).rejects.toThrow(
    "supported storage size",
  );
  for (const invalid of [
    { ...ref, name: "other/name" },
    { ...ref, service: "service\0secret" },
    { ...ref, name: "" },
  ])
    await expect(saveJsonSecret(invalid, {}, memory.store)).rejects.toThrow("Invalid secret reference");
  expect(memory.writes).toHaveLength(0);
});

test("same-reference saves serialize with a bounded lock", async () => {
  const memory = memoryStore();
  let release!: () => void;
  let started!: () => void;
  const written = new Promise<void>(resolve => {
    started = resolve;
  });
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const originalSet = memory.store.set;
  memory.store.set = async reference => {
    started();
    await blocked;
    await originalSet(reference);
  };
  const first = saveJsonSecret(ref, { secret: "local" }, memory.store);
  await written;
  await expect(saveJsonSecret(ref, { other: "local" }, memory.store)).rejects.toThrow("already in progress");
  release();
  await first;
  expect(await loadJsonSecret(ref, memory.store)).toEqual({ secret: "local" });
});

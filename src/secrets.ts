// SPDX-License-Identifier: Apache-2.0

export interface SecretReference {
  service: string;
  name: string;
}

export interface JsonSecretStore {
  get(reference: SecretReference): Promise<string | null>;
  set(reference: SecretReference & { value: string; persist: "local" }): Promise<void>;
  delete(reference: SecretReference): Promise<boolean>;
}

export interface JsonSecretMetadata {
  format: "json" | "chunked-json";
  bytes: number;
  chunks: number;
}

export class JsonSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSecretError";
  }
}

const FORMAT = "@aphrody/bun-video/chunked-json/v1";
const MARKER = "$bunVideoSecret";
const CREDENTIAL_BYTES = 2400;
const PART_BYTES = 1797;
const MAX_BYTES = 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_BYTES / PART_BYTES);
const encoder = new TextEncoder();
const writers = new Set<string>();

interface Manifest {
  $bunVideoSecret: typeof FORMAT;
  generation: string;
  bytes: number;
  chunks: number;
  sha256: string;
}

const nativeStore: JsonSecretStore = {
  get: reference => Bun.secrets.get(reference),
  set: reference => Bun.secrets.set(reference),
  delete: reference => Bun.secrets.delete(reference),
};

function checkedReference(reference: SecretReference): SecretReference {
  if (
    !reference ||
    typeof reference.service !== "string" ||
    typeof reference.name !== "string" ||
    !reference.service ||
    !reference.name ||
    reference.service.length > 128 ||
    reference.name.length > 128 ||
    /[\p{Cc}\p{Cf}\s\\]/u.test(reference.service) ||
    /[\p{Cc}\p{Cf}\s/\\]/u.test(reference.name)
  )
    throw new JsonSecretError("Invalid secret reference");
  return { service: reference.service, name: reference.name };
}

function partReference(reference: SecretReference, generation: string, index: number): SecretReference {
  return { service: reference.service, name: `${reference.name}.part.${generation}.${index}` };
}

async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parse(value: string): unknown {
  if (encoder.encode(value).length > CREDENTIAL_BYTES)
    throw new JsonSecretError("Secret credential exceeds the bounded storage size");
  try {
    return JSON.parse(value);
  } catch {
    throw new JsonSecretError("Secret credential contains invalid JSON");
  }
}

function manifest(value: Record<string, unknown>): Manifest {
  const generation = value.generation;
  const bytes = value.bytes;
  const chunks = value.chunks;
  if (
    Object.keys(value).length !== 5 ||
    value[MARKER] !== FORMAT ||
    typeof generation !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(generation) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes <= CREDENTIAL_BYTES ||
    bytes > MAX_BYTES ||
    typeof chunks !== "number" ||
    !Number.isSafeInteger(chunks) ||
    chunks < 2 ||
    chunks > MAX_CHUNKS ||
    chunks !== Math.ceil(bytes / PART_BYTES) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new JsonSecretError("Secret chunk manifest is invalid");
  return value as unknown as Manifest;
}

export async function loadJsonSecret(
  reference: SecretReference,
  store: JsonSecretStore = nativeStore,
): Promise<unknown | null> {
  const ref = checkedReference(reference);
  try {
    const root = await store.get(ref);
    if (root === null) return null;
    const value = parse(root);
    if (!value || typeof value !== "object" || Array.isArray(value) || !(MARKER in value)) return value;
    const descriptor = manifest(value as Record<string, unknown>);
    const bytes = new Uint8Array(descriptor.bytes);
    for (let index = 0; index < descriptor.chunks; index++) {
      const raw = await store.get(partReference(ref, descriptor.generation, index));
      if (raw === null) throw new JsonSecretError("Secret chunk is missing");
      const part = parse(raw);
      if (
        typeof part !== "string" ||
        !part ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part)
      )
        throw new JsonSecretError("Secret chunk encoding is invalid");
      let binary: string;
      try {
        binary = atob(part);
      } catch {
        throw new JsonSecretError("Secret chunk encoding is invalid");
      }
      if (btoa(binary) !== part || binary.length !== Math.min(PART_BYTES, descriptor.bytes - index * PART_BYTES))
        throw new JsonSecretError("Secret chunk length or encoding is invalid");
      const offset = index * PART_BYTES;
      for (let cursor = 0; cursor < binary.length; cursor++) bytes[offset + cursor] = binary.charCodeAt(cursor);
    }
    if ((await digest(bytes)) !== descriptor.sha256) throw new JsonSecretError("Secret checksum validation failed");
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new JsonSecretError("Secret JSON text encoding is invalid");
    }
    try {
      return JSON.parse(json);
    } catch {
      throw new JsonSecretError("Secret data contains invalid JSON");
    }
  } catch (error) {
    if (error instanceof JsonSecretError) throw error;
    throw new JsonSecretError("Secret credential read failed");
  }
}

export async function saveJsonSecret(
  reference: SecretReference,
  value: unknown,
  store: JsonSecretStore = nativeStore,
): Promise<JsonSecretMetadata> {
  const ref = checkedReference(reference);
  if (value && typeof value === "object" && !Array.isArray(value) && MARKER in value)
    throw new JsonSecretError("Secret JSON contains a reserved storage marker");
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new JsonSecretError("Secret value must be JSON serializable");
  }
  if (json === undefined) throw new JsonSecretError("Secret value must be JSON serializable");
  const serialized = JSON.parse(json) as unknown;
  if (serialized && typeof serialized === "object" && !Array.isArray(serialized) && MARKER in serialized)
    throw new JsonSecretError("Secret JSON contains a reserved storage marker");
  const bytes = encoder.encode(json);
  if (bytes.length > MAX_BYTES) throw new JsonSecretError("Secret JSON exceeds the supported storage size");
  const lock = `${ref.service}\0${ref.name}`.toLowerCase();
  if (writers.has(lock)) throw new JsonSecretError("A write to this secret reference is already in progress");
  writers.add(lock);
  const attempted: { reference: SecretReference; value: string }[] = [];
  try {
    if ((await store.get(ref)) !== null)
      throw new JsonSecretError("Secret reference already exists; overwrite is refused");
    const generation = crypto.randomUUID();
    const chunks = bytes.length <= CREDENTIAL_BYTES ? 0 : Math.ceil(bytes.length / PART_BYTES);
    for (let index = 0; index < chunks; index++) {
      const partRef = partReference(ref, generation, index);
      if ((await store.get(partRef)) !== null) throw new JsonSecretError("Secret chunk reference already exists");
      const part = bytes.subarray(index * PART_BYTES, Math.min(bytes.length, (index + 1) * PART_BYTES));
      const partValue = JSON.stringify(btoa(String.fromCharCode(...part)));
      attempted.push({ reference: partRef, value: partValue });
      await store.set({ ...partRef, value: partValue, persist: "local" });
    }
    const rootValue = chunks
      ? JSON.stringify({
          [MARKER]: FORMAT,
          generation,
          bytes: bytes.length,
          chunks,
          sha256: await digest(bytes),
        })
      : json;
    if (encoder.encode(rootValue).length > CREDENTIAL_BYTES)
      throw new JsonSecretError("Secret manifest exceeds the bounded storage size");
    if ((await store.get(ref)) !== null)
      throw new JsonSecretError("Secret reference was created concurrently; overwrite is refused");
    attempted.push({ reference: ref, value: rootValue });
    await store.set({ ...ref, value: rootValue, persist: "local" });
    return { format: chunks ? "chunked-json" : "json", bytes: bytes.length, chunks };
  } catch (error) {
    let incomplete = false;
    for (const entry of attempted.toReversed()) {
      try {
        if ((await store.get(entry.reference)) === entry.value && !(await store.delete(entry.reference)))
          incomplete = true;
      } catch {
        incomplete = true;
      }
    }
    if (incomplete) throw new JsonSecretError("Secret write failed; owned rollback was incomplete");
    if (error instanceof JsonSecretError) throw error;
    throw new JsonSecretError("Secret credential write failed");
  } finally {
    writers.delete(lock);
  }
}

import { CString, FFIType, dlopen, ptr, toArrayBuffer, type FFIFunction, type Pointer } from "bun:ffi";
import { join } from "node:path";
import { mediaSDKLibraryDirectory, mediaSDKPlan } from "./sdk";
import { mediaSDKHostTarget } from "./sdk-platform";

const functionABI = <
  const A extends NonNullable<FFIFunction["args"]>,
  const R extends NonNullable<FFIFunction["returns"]>,
>(
  args: A,
  returns: R,
) => ({ args, returns });
const p = "ptr";
const i = "i32";
const v = "void";

export const mpvABI = {
  mpv_create: { args: [], returns: FFIType.pointer },
  mpv_initialize: { args: [FFIType.pointer], returns: FFIType.i32 },
  mpv_set_option_string: { args: [FFIType.pointer, FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
  mpv_command: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.i32 },
  mpv_set_property_string: { args: [FFIType.pointer, FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
  mpv_get_property_string: { args: [FFIType.pointer, FFIType.cstring], returns: FFIType.pointer },
  mpv_free: { args: [FFIType.pointer], returns: FFIType.void },
  mpv_wait_event: { args: [FFIType.pointer, FFIType.double], returns: FFIType.pointer },
  mpv_terminate_destroy: { args: [FFIType.pointer], returns: FFIType.void },
  mpv_client_api_version: functionABI([], process.platform === "win32" ? "u32" : "u64"),
  mpv_error_string: functionABI([i], p),
  mpv_client_name: functionABI([p], p),
  mpv_client_id: functionABI([p], "i64"),
  mpv_destroy: functionABI([p], v),
  mpv_create_client: functionABI([p, p], p),
  mpv_create_weak_client: functionABI([p, p], p),
  mpv_load_config_file: functionABI([p, p], i),
  mpv_get_time_ns: functionABI([p], "i64"),
  mpv_get_time_us: functionABI([p], "i64"),
  mpv_free_node_contents: functionABI([p], v),
  mpv_set_option: functionABI([p, p, i, p], i),
  mpv_command_node: functionABI([p, p, p], i),
  mpv_command_ret: functionABI([p, p, p], i),
  mpv_command_string: functionABI([p, p], i),
  mpv_command_async: functionABI([p, "u64", p], i),
  mpv_command_node_async: functionABI([p, "u64", p], i),
  mpv_abort_async_command: functionABI([p, "u64"], v),
  mpv_set_property: functionABI([p, p, i, p], i),
  mpv_del_property: functionABI([p, p], i),
  mpv_set_property_async: functionABI([p, "u64", p, i, p], i),
  mpv_get_property: functionABI([p, p, i, p], i),
  mpv_get_property_osd_string: functionABI([p, p], p),
  mpv_get_property_async: functionABI([p, "u64", p, i], i),
  mpv_observe_property: functionABI([p, "u64", p, i], i),
  mpv_unobserve_property: functionABI([p, "u64"], i),
  mpv_event_name: functionABI([i], p),
  mpv_event_to_node: functionABI([p, p], i),
  mpv_request_event: functionABI([p, i, i], i),
  mpv_request_log_messages: functionABI([p, p], i),
  mpv_wakeup: functionABI([p], v),
  mpv_set_wakeup_callback: functionABI([p, p, p], v),
  mpv_wait_async_requests: functionABI([p], v),
  mpv_hook_add: functionABI([p, "u64", p, i], i),
  mpv_hook_continue: functionABI([p, "u64"], i),
  mpv_get_wakeup_pipe: functionABI([p], i),
  mpv_render_context_create: functionABI([p, p, p], i),
  mpv_render_context_set_update_callback: functionABI([p, p, p], v),
  mpv_render_context_update: functionABI([p], "u64"),
  mpv_render_context_render: functionABI([p, p], i),
  mpv_render_context_report_swap: functionABI([p], v),
  mpv_render_context_free: functionABI([p], v),
  mpv_stream_cb_add_ro: functionABI([p, p, p, p], i),
} as const;

type MpvSymbols = typeof mpvABI;

export type MpvLibraryOptions = { libraryPath?: string; options?: Readonly<Record<string, string>> };

export interface MpvEvent {
  readonly id: number;
  readonly name: string;
  readonly error: number;
  readonly replyUserdata: bigint;
}

export function mpvLibraryPath(directory = mediaSDKLibraryDirectory("mpv")): string {
  const target = mediaSDKHostTarget();
  const libraryName = mediaSDKPlan("mpv", target).libraryName;
  if (!libraryName) throw new Error("The media SDK does not declare an mpv library");
  return join(directory, libraryName);
}

function cstring(value: string): Uint8Array {
  if (value.includes("\0")) throw new TypeError("mpv strings must not contain NUL");
  return new TextEncoder().encode(`${value}\0`);
}

export class MpvClient {
  readonly #library: ReturnType<typeof dlopen<MpvSymbols>>;
  readonly #handle: Pointer;
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) throw new Error("mpv client is closed");
  }

  private constructor(library: ReturnType<typeof dlopen<MpvSymbols>>, handle: Pointer) {
    this.#library = library;
    this.#handle = handle;
  }

  get pointer(): Pointer {
    this.#assertOpen();
    return this.#handle;
  }

  get symbols() {
    this.#assertOpen();
    return this.#library.symbols;
  }

  static open(options: MpvLibraryOptions = {}): MpvClient {
    const libraryPath = options.libraryPath ?? mpvLibraryPath();
    const library = dlopen(libraryPath, mpvABI);
    const handle = library.symbols.mpv_create();
    if (!handle) {
      library.close();
      throw new Error("mpv_create failed");
    }
    try {
      for (const [name, value] of Object.entries(options.options ?? {})) {
        const status = library.symbols.mpv_set_option_string(handle, ptr(cstring(name)), ptr(cstring(value)));
        if (status < 0) throw new Error(`mpv_set_option_string failed: ${status}`);
      }
      const status = library.symbols.mpv_initialize(handle);
      if (status < 0) throw new Error(`mpv_initialize failed: ${status}`);
      return new MpvClient(library, handle as Pointer);
    } catch (error) {
      library.symbols.mpv_terminate_destroy(handle);
      library.close();
      throw error;
    }
  }

  command(...args: string[]): void {
    this.#command(args);
  }

  commandAsync(replyUserdata: bigint, ...args: string[]): void {
    this.#assertOpen();
    if (typeof replyUserdata !== "bigint" || replyUserdata < 0n || replyUserdata > 0xffffffffffffffffn)
      throw new TypeError("mpv reply userdata must be an unsigned 64-bit bigint");
    this.#command(args, replyUserdata);
  }

  #command(args: readonly string[], replyUserdata?: bigint): void {
    this.#assertOpen();
    if (args.length === 0) throw new TypeError("mpv command requires at least one argument");
    const encoded = args.map(cstring);
    const argv = new Uint8Array((encoded.length + 1) * 8);
    const pointers = new DataView(argv.buffer);
    for (let index = 0; index < encoded.length; index++)
      pointers.setBigUint64(index * 8, BigInt(ptr(encoded[index])), true);
    const status =
      replyUserdata === undefined
        ? this.#library.symbols.mpv_command(this.#handle, ptr(argv))
        : this.#library.symbols.mpv_command_async(this.#handle, replyUserdata, ptr(argv));
    if (status < 0) throw new Error(`mpv command failed: ${status}`);
  }

  setProperty(name: string, value: string): void {
    this.#assertOpen();
    const status = this.#library.symbols.mpv_set_property_string(this.#handle, ptr(cstring(name)), ptr(cstring(value)));
    if (status < 0) throw new Error(`mpv_set_property_string failed: ${status}`);
  }

  getProperty(name: string): string | null {
    this.#assertOpen();
    const value = this.#library.symbols.mpv_get_property_string(this.#handle, ptr(cstring(name)));
    if (!value) return null;
    const pointer = Number(value) as Pointer;
    try {
      return new CString(pointer).toString();
    } finally {
      this.#library.symbols.mpv_free(pointer);
    }
  }

  waitEvent(timeoutSeconds = 0): Pointer | null {
    this.#assertOpen();
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)
      throw new TypeError("mpv timeout must be finite and nonnegative");
    return this.#library.symbols.mpv_wait_event(this.#handle, timeoutSeconds) as Pointer | null;
  }

  nextEvent(timeoutSeconds = 0): MpvEvent {
    const pointer = this.waitEvent(timeoutSeconds);
    if (!pointer) throw new Error("mpv_wait_event returned no event structure");
    // mpv owns this structure only until the next wait; copy its scalar fields now.
    const view = new DataView(toArrayBuffer(pointer, 0, 16));
    const id = view.getInt32(0, true);
    const error = view.getInt32(4, true);
    const replyUserdata = view.getBigUint64(8, true);
    const namePointer = this.#library.symbols.mpv_event_name(id);
    const name = namePointer ? new CString(Number(namePointer) as Pointer).toString() : "unknown";
    return { id, name, error, replyUserdata };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#library.symbols.mpv_terminate_destroy(this.#handle);
    this.#library.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

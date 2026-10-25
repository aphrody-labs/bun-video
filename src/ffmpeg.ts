import { CString, dlopen, ptr, type FFIFunction, type Pointer } from "bun:ffi";
import { isAbsolute, join } from "node:path";
import { MAX_MEMORY_SOURCE_BYTES } from "./source";
import { mediaSDKLibraryDirectory } from "./sdk";

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

const memoryABI = {
  bun_video_memory_api_version: functionABI([], "u32"),
  bun_video_memory_open: functionABI([p, "u64", p], i),
  bun_video_memory_format: functionABI([p], p),
  bun_video_memory_close: functionABI([p], v),
} as const;

export const ffmpegABI = {
  avutil: {
    avutil_version: functionABI([], "u32"),
    av_version_info: functionABI([], p),
    av_strerror: functionABI([i, p, "u64"], i),
    av_malloc: functionABI(["u64"], p),
    av_free: functionABI([p], v),
    av_frame_alloc: functionABI([], p),
    av_frame_free: functionABI([p], v),
    av_frame_unref: functionABI([p], v),
    av_frame_ref: functionABI([p, p], i),
    av_frame_clone: functionABI([p], p),
    av_frame_copy: functionABI([p, p], i),
    av_frame_copy_props: functionABI([p, p], i),
    av_frame_get_buffer: functionABI([p, i], i),
    av_frame_make_writable: functionABI([p], i),
    av_dict_set: functionABI([p, p, p, i], i),
    av_dict_count: functionABI([p], i),
    av_dict_free: functionABI([p], v),
    av_opt_set: functionABI([p, p, p, i], i),
    av_opt_set_int: functionABI([p, p, "i64", i], i),
    av_hwdevice_ctx_create: functionABI([p, i, p, p, i], i),
    av_hwframe_transfer_data: functionABI([p, p, i], i),
    av_hwdevice_find_type_by_name: functionABI([p], i),
    av_hwdevice_get_type_name: functionABI([i], p),
    av_hwdevice_iterate_types: functionABI([i], i),
    av_hwframe_ctx_alloc: functionABI([p], p),
    av_hwframe_ctx_init: functionABI([p], i),
    av_hwframe_get_buffer: functionABI([p, p, i], i),
    av_buffer_ref: functionABI([p], p),
    av_buffer_unref: functionABI([p], v),
    av_get_pix_fmt: functionABI([p], i),
    av_get_pix_fmt_name: functionABI([i], p),
    av_get_sample_fmt: functionABI([p], i),
    av_get_sample_fmt_name: functionABI([i], p),
    av_get_bytes_per_sample: functionABI([i], i),
    av_sample_fmt_is_planar: functionABI([i], i),
    av_image_get_buffer_size: functionABI([i, i, i, i], i),
  },
  avcodec: {
    avcodec_version: functionABI([], "u32"),
    avcodec_get_name: functionABI([i], p),
    avcodec_find_decoder: functionABI([i], p),
    avcodec_find_encoder: functionABI([i], p),
    avcodec_find_decoder_by_name: functionABI([p], p),
    avcodec_find_encoder_by_name: functionABI([p], p),
    avcodec_alloc_context3: functionABI([p], p),
    avcodec_free_context: functionABI([p], v),
    avcodec_open2: functionABI([p, p, p], i),
    avcodec_parameters_to_context: functionABI([p, p], i),
    avcodec_parameters_from_context: functionABI([p, p], i),
    avcodec_parameters_alloc: functionABI([], p),
    avcodec_parameters_free: functionABI([p], v),
    avcodec_parameters_copy: functionABI([p, p], i),
    avcodec_send_packet: functionABI([p, p], i),
    avcodec_receive_frame: functionABI([p, p], i),
    avcodec_send_frame: functionABI([p, p], i),
    avcodec_receive_packet: functionABI([p, p], i),
    avcodec_flush_buffers: functionABI([p], v),
    av_packet_alloc: functionABI([], p),
    av_packet_free: functionABI([p], v),
    av_packet_unref: functionABI([p], v),
    av_packet_clone: functionABI([p], p),
    av_packet_ref: functionABI([p, p], i),
    av_packet_move_ref: functionABI([p, p], v),
    av_packet_make_refcounted: functionABI([p], i),
    av_packet_make_writable: functionABI([p], i),
    av_codec_iterate: functionABI([p], p),
  },
  avformat: {
    avformat_version: functionABI([], "u32"),
    avformat_network_init: functionABI([], i),
    avformat_alloc_context: functionABI([], p),
    av_demuxer_iterate: functionABI([p], p),
    av_muxer_iterate: functionABI([p], p),
    avformat_open_input: functionABI([p, p, p, p], i),
    avformat_find_stream_info: functionABI([p, p], i),
    av_find_best_stream: functionABI([p, i, i, i, p, i], i),
    avformat_flush: functionABI([p], i),
    avformat_close_input: functionABI([p], v),
    av_read_frame: functionABI([p, p], i),
    av_seek_frame: functionABI([p, i, "i64", i], i),
    avformat_alloc_output_context2: functionABI([p, p, p, p], i),
    avformat_new_stream: functionABI([p, p], p),
    avformat_write_header: functionABI([p, p], i),
    av_interleaved_write_frame: functionABI([p, p], i),
    av_write_trailer: functionABI([p], i),
    avformat_free_context: functionABI([p], v),
    avio_open: functionABI([p, p, i], i),
    avio_closep: functionABI([p], i),
  },
  avfilter: {
    avfilter_version: functionABI([], "u32"),
    avfilter_graph_alloc: functionABI([], p),
    avfilter_graph_free: functionABI([p], v),
    avfilter_get_by_name: functionABI([p], p),
    avfilter_graph_create_filter: functionABI([p, p, p, p, p, p], i),
    avfilter_inout_alloc: functionABI([], p),
    avfilter_inout_free: functionABI([p], v),
    avfilter_graph_parse_ptr: functionABI([p, p, p, p, p], i),
    avfilter_graph_config: functionABI([p, p], i),
    av_buffersrc_add_frame_flags: functionABI([p, p, i], i),
    av_buffersink_get_frame: functionABI([p, p], i),
  },
  swscale: {
    swscale_version: functionABI([], "u32"),
    sws_getContext: functionABI([i, i, i, i, i, i, i, p, p, p], p),
    sws_scale: functionABI([p, p, p, i, i, p, p], i),
    sws_scale_frame: functionABI([p, p, p], i),
    sws_isSupportedInput: functionABI([i], i),
    sws_isSupportedOutput: functionABI([i], i),
    sws_isSupportedEndiannessConversion: functionABI([i], i),
    sws_freeContext: functionABI([p], v),
  },
  swresample: {
    swresample_version: functionABI([], "u32"),
    swr_alloc: functionABI([], p),
    swr_alloc_set_opts2: functionABI([p, p, i, i, p, i, i, i, p], i),
    swr_init: functionABI([p], i),
    swr_close: functionABI([p], v),
    swr_convert_frame: functionABI([p, p, p], i),
    swr_config_frame: functionABI([p, p, p], i),
    swr_convert: functionABI([p, p, i, p, i], i),
    swr_get_delay: functionABI([p, "i64"], "i64"),
    swr_free: functionABI([p], v),
  },
  avdevice: {
    avdevice_version: functionABI([], "u32"),
    avdevice_register_all: functionABI([], v),
    av_input_audio_device_next: functionABI([p], p),
    av_input_video_device_next: functionABI([p], p),
    av_output_audio_device_next: functionABI([p], p),
    av_output_video_device_next: functionABI([p], p),
    avdevice_list_devices: functionABI([p, p], i),
    avdevice_free_list_devices: functionABI([p], v),
    avdevice_list_input_sources: functionABI([p, p, p, p], i),
    avdevice_list_output_sinks: functionABI([p, p, p, p], i),
    avdevice_app_to_dev_control_message: functionABI([p, i, p, "u64"], i),
    avdevice_dev_to_app_control_message: functionABI([p, i, p, "u64"], i),
  },
} as const;

export type FFmpegComponent = keyof typeof ffmpegABI;
export const ffmpegMajors = {
  avutil: 61,
  avcodec: 63,
  avformat: 63,
  avfilter: 12,
  swscale: 10,
  swresample: 7,
  avdevice: 63,
} as const;

export function ffmpegLibraryPath(component: FFmpegComponent, directory = mediaSDKLibraryDirectory("ffmpeg")): string {
  if (!isAbsolute(directory)) throw new TypeError("FFmpeg library directory must be absolute");
  const major = ffmpegMajors[component];
  const name =
    process.platform === "win32"
      ? `${component}-${major}.dll`
      : process.platform === "darwin"
        ? `lib${component}.${major}.dylib`
        : `lib${component}.so.${major}`;
  return join(directory, name);
}

export function openFFmpegComponent<C extends FFmpegComponent>(component: C, directory?: string) {
  return dlopen(ffmpegLibraryPath(component, directory), ffmpegABI[component]);
}

type FFmpegLibrary<C extends FFmpegComponent> = ReturnType<typeof openFFmpegComponent<C>>;
type FFmpegLibraries = { [C in FFmpegComponent]: FFmpegLibrary<C> };

export class FFmpeg {
  readonly #libraries: FFmpegLibraries;
  readonly #directory: string;
  #memoryIO?: ReturnType<typeof dlopen<typeof memoryABI>>;
  #closed = false;
  readonly #resources = new Set<() => void>();

  private constructor(libraries: FFmpegLibraries, directory: string) {
    this.#libraries = libraries;
    this.#directory = directory;
  }

  static open(directory?: string): FFmpeg {
    const selectedDirectory = mediaSDKLibraryDirectory("ffmpeg", directory);
    const libraries: Partial<FFmpegLibraries> = {};
    const owned: Array<{ close(): void }> = [];
    try {
      for (const component of [
        "avutil",
        "swresample",
        "swscale",
        "avcodec",
        "avformat",
        "avfilter",
        "avdevice",
      ] as const) {
        const library = openFFmpegComponent(component, selectedDirectory);
        owned.push(library);
        const version = (library.symbols as Record<string, (...args: never[]) => unknown>)[`${component}_version`]();
        if (typeof version !== "number" || version >>> 16 !== ffmpegMajors[component])
          throw new Error(`FFmpeg ${component} ABI mismatch: expected major ${ffmpegMajors[component]}`);
        Object.assign(libraries, { [component]: library });
      }
      return new FFmpeg(libraries as FFmpegLibraries, selectedDirectory);
    } catch (error) {
      for (const library of owned.reverse()) library.close();
      throw error;
    }
  }

  get libraries(): Readonly<FFmpegLibraries> {
    if (this.#closed) throw new Error("FFmpeg is closed");
    return this.#libraries;
  }

  check(status: number): number {
    if (status >= 0) return status;
    const bytes = new Uint8Array(256);
    const code = this.libraries.avutil.symbols.av_strerror(status, ptr(bytes), BigInt(bytes.length));
    const detail = code < 0 ? String(status) : new CString(ptr(bytes)).toString();
    throw new Error(`FFmpeg: ${detail} (${status})`);
  }

  #withOptions<T>(options: Readonly<Record<string, string>> | undefined, operation: (dictionary: Pointer) => T): T {
    const api = this.libraries.avutil.symbols;
    const dictionary = new BigUint64Array(1);
    try {
      for (const [key, value] of Object.entries(options ?? {})) {
        if (!key || key.includes("\0") || typeof value !== "string" || value.includes("\0"))
          throw new TypeError("FFmpeg options require nonempty keys and string values without NUL");
        const encodedKey = new TextEncoder().encode(`${key}\0`);
        const encodedValue = new TextEncoder().encode(`${value}\0`);
        this.check(api.av_dict_set(ptr(dictionary), ptr(encodedKey), ptr(encodedValue), 0));
      }
      const result = operation(ptr(dictionary));
      if (dictionary[0] && api.av_dict_count(Number(dictionary[0]) as Pointer) > 0)
        throw new Error("FFmpeg options were not recognized by the codec or protocol");
      return result;
    } finally {
      api.av_dict_free(ptr(dictionary));
    }
  }

  openInput(url: string, options?: Readonly<Record<string, string>>): FFmpegInput {
    if (url.includes("\0")) throw new TypeError("FFmpeg input must not contain NUL");
    const api = this.libraries.avformat.symbols;
    const slot = new BigUint64Array(1);
    const encoded = new TextEncoder().encode(`${url}\0`);
    try {
      this.#withOptions(options, dictionary =>
        this.check(api.avformat_open_input(ptr(slot), ptr(encoded), null, dictionary)),
      );
      this.check(api.avformat_find_stream_info(Number(slot[0]) as Pointer, null));
    } catch (error) {
      api.avformat_close_input(ptr(slot));
      throw error;
    }
    const context = Number(slot[0]) as Pointer;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      api.avformat_close_input(ptr(slot));
      this.#resources.delete(close);
    };
    this.#resources.add(close);
    return {
      get pointer() {
        if (closed) throw new Error("FFmpeg input is closed");
        return context;
      },
      close,
      [Symbol.dispose]: close,
    };
  }

  openMemory(data: ArrayBuffer | ArrayBufferView): FFmpegInput {
    if (this.#closed) throw new Error("FFmpeg is closed");
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))
      throw new TypeError("FFmpeg memory input requires an ArrayBuffer or byte view");
    let bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    if (!bytes.byteLength || bytes.byteLength > MAX_MEMORY_SOURCE_BYTES)
      throw new RangeError("FFmpeg memory input must contain 1..536870912 bytes");
    if (bytes.buffer instanceof SharedArrayBuffer) bytes = new Uint8Array(bytes);
    if (!this.#memoryIO) {
      const name =
        process.platform === "win32"
          ? "bun_video_native.dll"
          : process.platform === "darwin"
            ? "libbun_video_native.dylib"
            : "libbun_video_native.so";
      const library = dlopen(join(this.#directory, name), memoryABI);
      if (library.symbols.bun_video_memory_api_version() !== 1) {
        library.close();
        throw new Error("Bun Video memory input ABI mismatch");
      }
      this.#memoryIO = library;
    }
    const api = this.#memoryIO.symbols;
    const slot = new BigUint64Array(1);
    this.check(api.bun_video_memory_open(ptr(bytes), BigInt(bytes.byteLength), ptr(slot)));
    const context = api.bun_video_memory_format(Number(slot[0]) as Pointer);
    if (!context) {
      api.bun_video_memory_close(ptr(slot));
      throw new Error("Bun Video memory input has no format context");
    }
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      api.bun_video_memory_close(ptr(slot));
      this.#resources.delete(close);
    };
    this.#resources.add(close);
    return {
      get pointer() {
        if (closed) throw new Error("FFmpeg input is closed");
        return Number(context) as Pointer;
      },
      close,
      [Symbol.dispose]: close,
    };
  }

  allocateFrame(): FFmpegFrame {
    const api = this.libraries.avutil.symbols;
    return this.#ownReference("frame", api.av_frame_alloc(), api.av_frame_free, api.av_frame_unref);
  }

  allocatePacket(): FFmpegPacket {
    const api = this.libraries.avcodec.symbols;
    return this.#ownReference("packet", api.av_packet_alloc(), api.av_packet_free, api.av_packet_unref);
  }

  #openCodec(
    name: string,
    kind: "decoder" | "encoder",
    parameters?: Pointer,
    options?: Readonly<Record<string, string>>,
  ): FFmpegPacket {
    if (!name || name.includes("\0")) throw new TypeError(`FFmpeg ${kind} name must be nonempty and contain no NUL`);
    const api = this.libraries.avcodec.symbols;
    const encoded = new TextEncoder().encode(`${name}\0`);
    const codec =
      kind === "decoder"
        ? api.avcodec_find_decoder_by_name(ptr(encoded))
        : api.avcodec_find_encoder_by_name(ptr(encoded));
    if (!codec) throw new Error(`FFmpeg ${kind} not found: ${name}`);
    const context = this.#ownReference(
      kind,
      api.avcodec_alloc_context3(codec),
      api.avcodec_free_context,
      api.avcodec_flush_buffers,
    );
    try {
      if (parameters !== undefined) this.check(api.avcodec_parameters_to_context(context.pointer, parameters));
      this.#withOptions(options, dictionary => this.check(api.avcodec_open2(context.pointer, codec, dictionary)));
    } catch (error) {
      context.close();
      throw error;
    }
    return context;
  }

  #codecStatus(status: number): FFmpegCodecStatus {
    if (status === -11) return "again";
    if (status === -541478725) return "eof";
    this.check(status);
    return "ok";
  }

  openDecoder(name: string, parameters?: Pointer, options?: Readonly<Record<string, string>>): FFmpegDecoder {
    const api = this.libraries.avcodec.symbols;
    const context = this.#openCodec(name, "decoder", parameters, options);
    return {
      get pointer() {
        return context.pointer;
      },
      sendPacket: packet => this.#codecStatus(api.avcodec_send_packet(context.pointer, packet?.pointer ?? null)),
      receiveFrame: frame => {
        const pointer = context.pointer;
        frame.unref();
        return this.#codecStatus(api.avcodec_receive_frame(pointer, frame.pointer));
      },
      flush: () => context.unref(),
      close: context.close,
      [Symbol.dispose]: context.close,
    };
  }

  openEncoder(name: string, options?: Readonly<Record<string, string>>, parameters?: Pointer): FFmpegEncoder {
    const api = this.libraries.avcodec.symbols;
    const context = this.#openCodec(name, "encoder", parameters, options);
    return {
      get pointer() {
        return context.pointer;
      },
      sendFrame: frame => this.#codecStatus(api.avcodec_send_frame(context.pointer, frame?.pointer ?? null)),
      receivePacket: packet => {
        const pointer = context.pointer;
        packet.unref();
        return this.#codecStatus(api.avcodec_receive_packet(pointer, packet.pointer));
      },
      close: context.close,
      [Symbol.dispose]: context.close,
    };
  }

  #ownReference(
    kind: "frame" | "packet" | "decoder" | "encoder",
    allocated: Pointer | number | bigint | null,
    free: (slot: Pointer) => void,
    unref: (value: Pointer) => void,
  ): FFmpegPacket {
    if (!allocated) throw new Error(`FFmpeg ${kind} allocation failed`);
    const value = Number(allocated) as Pointer;
    const slot = new BigUint64Array([BigInt(value)]);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      free(ptr(slot));
      this.#resources.delete(close);
    };
    this.#resources.add(close);
    return {
      get pointer() {
        if (closed) throw new Error(`FFmpeg ${kind} is closed`);
        return value;
      },
      unref() {
        if (closed) throw new Error(`FFmpeg ${kind} is closed`);
        unref(value);
      },
      close,
      [Symbol.dispose]: close,
    };
  }

  readPacket(input: FFmpegInput, packet: FFmpegPacket): boolean {
    packet.unref();
    const status = this.libraries.avformat.symbols.av_read_frame(input.pointer, packet.pointer);
    if (status === -541478725) return false;
    this.check(status);
    return true;
  }

  findStream(input: FFmpegInput, type: "video" | "audio" | "subtitle"): number {
    const mediaTypes = { video: 0, audio: 1, subtitle: 3 } as const;
    if (!Object.hasOwn(mediaTypes, type)) throw new TypeError("Unknown FFmpeg media type");
    return this.check(
      this.libraries.avformat.symbols.av_find_best_stream(input.pointer, mediaTypes[type], -1, -1, null, 0),
    );
  }

  seek(input: FFmpegInput, timestampMicroseconds: bigint): void {
    if (
      typeof timestampMicroseconds !== "bigint" ||
      timestampMicroseconds < -(1n << 63n) ||
      timestampMicroseconds > (1n << 63n) - 1n
    )
      throw new TypeError("FFmpeg seek timestamp must be a signed 64-bit bigint in microseconds");
    this.check(this.libraries.avformat.symbols.av_seek_frame(input.pointer, -1, timestampMicroseconds, 1));
  }

  close(): void {
    if (this.#closed) return;
    for (const close of [...this.#resources].reverse()) close();
    this.#closed = true;
    this.#memoryIO?.close();
    for (const library of Object.values(this.#libraries).reverse()) library.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export interface FFmpegInput extends Disposable {
  readonly pointer: Pointer;
  close(): void;
}

export interface FFmpegPacket extends FFmpegInput {
  unref(): void;
}

export interface FFmpegFrame extends FFmpegInput {
  unref(): void;
}

export type FFmpegCodecStatus = "ok" | "again" | "eof";

export interface FFmpegDecoder extends FFmpegInput {
  sendPacket(packet: FFmpegPacket | null): FFmpegCodecStatus;
  receiveFrame(frame: FFmpegFrame): FFmpegCodecStatus;
  flush(): void;
}

export interface FFmpegEncoder extends FFmpegInput {
  sendFrame(frame: FFmpegFrame | null): FFmpegCodecStatus;
  receivePacket(packet: FFmpegPacket): FFmpegCodecStatus;
}

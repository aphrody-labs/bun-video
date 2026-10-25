use crate::memory_io::{InterruptBudget, MemoryInput};
use ffmpeg_sys_next as ffi;
use std::{
    ffi::{CStr, CString},
    io::Write,
    path::Path,
    ptr,
};

const MAX_PACKETS: usize = 100_000;
const MAX_FRAMES: usize = 100_000;
const MAX_FRAME_BYTES: usize = 256 * 1024 * 1024;
#[cfg(target_os = "macos")]
const AGAIN: i32 = -35;
#[cfg(not(target_os = "macos"))]
const AGAIN: i32 = -11;

pub enum VideoInput<'a> {
    Path(&'a Path),
    Bytes(std::sync::Arc<[u8]>),
}
#[derive(Debug)]
pub enum VideoError {
    Invalid(&'static str),
    Codec(i32),
    Io(std::io::Error),
}
impl std::fmt::Display for VideoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Io(error) => error.fmt(f),
            Self::Codec(code) => {
                #[cfg(windows)]
                if crate::windows_provider::ensure_loaded().is_err() {
                    return write!(f, "FFmpeg error {code}");
                }
                let mut text = [0 as std::ffi::c_char; 256];
                // SAFETY: av_strerror writes at most this array's capacity and terminates on success.
                if unsafe { ffi::av_strerror(*code, text.as_mut_ptr(), text.len()) } == 0 {
                    f.write_str(&unsafe { CStr::from_ptr(text.as_ptr()) }.to_string_lossy())
                } else {
                    write!(f, "FFmpeg error {code}")
                }
            }
        }
    }
}
impl std::error::Error for VideoError {}
impl From<std::io::Error> for VideoError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
fn status(code: i32) -> Result<(), VideoError> {
    if code < 0 {
        Err(VideoError::Codec(code))
    } else {
        Ok(())
    }
}

pub(crate) fn verify_abi() -> Result<(), VideoError> {
    #[cfg(windows)]
    crate::windows_provider::ensure_loaded()
        .map_err(|message| VideoError::Io(std::io::Error::other(message)))?;
    let expected = [
        env!("BUN_VIDEO_LIBAVCODEC_MAJOR"),
        env!("BUN_VIDEO_LIBAVFORMAT_MAJOR"),
        env!("BUN_VIDEO_LIBAVUTIL_MAJOR"),
        env!("BUN_VIDEO_LIBSWSCALE_MAJOR"),
    ];
    let actual = unsafe {
        [
            ffi::avcodec_version() >> 16,
            ffi::avformat_version() >> 16,
            ffi::avutil_version() >> 16,
            ffi::swscale_version() >> 16,
        ]
    };
    if expected
        .iter()
        .zip(actual)
        .any(|(expected, actual)| expected.parse::<u32>().ok() != Some(actual))
    {
        return Err(VideoError::Invalid(
            "FFmpeg DLL ABI differs from the compiled SDK headers",
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: Option<f64>,
    pub codec: String,
}
pub struct DecodedVideoFrame {
    pub width: u32,
    pub height: u32,
    pub timestamp_seconds: Option<f64>,
    pub png: Vec<u8>,
}
pub type VideoCancel = Option<std::sync::Arc<std::sync::atomic::AtomicBool>>;

macro_rules! owner {
    ($name:ident, $ty:ty, $alloc:path, $free:path) => {
        struct $name(*mut $ty);
        impl $name {
            fn new() -> Result<Self, VideoError> {
                // SAFETY: FFmpeg allocation returns null or a uniquely owned initialized resource.
                let value = unsafe { $alloc() };
                if value.is_null() {
                    Err(VideoError::Codec(-12))
                } else {
                    Ok(Self(value))
                }
            }
        }
        impl Drop for $name {
            fn drop(&mut self) {
                unsafe { $free(&mut self.0) };
            }
        }
    };
}
owner!(Frame, ffi::AVFrame, ffi::av_frame_alloc, ffi::av_frame_free);
owner!(
    Packet,
    ffi::AVPacket,
    ffi::av_packet_alloc,
    ffi::av_packet_free
);
struct Codec(*mut ffi::AVCodecContext);
impl Codec {
    fn new(codec: *const ffi::AVCodec) -> Result<Self, VideoError> {
        // SAFETY: codec is null or an immutable descriptor returned by the current FFmpeg library.
        let value = unsafe { ffi::avcodec_alloc_context3(codec) };
        if value.is_null() {
            Err(VideoError::Codec(-12))
        } else {
            Ok(Self(value))
        }
    }
}
impl Drop for Codec {
    fn drop(&mut self) {
        unsafe { ffi::avcodec_free_context(&mut self.0) };
    }
}
#[derive(Default)]
struct Dictionary(*mut ffi::AVDictionary);
impl Dictionary {
    fn set(&mut self, key: &CStr, value: &CStr) -> Result<(), VideoError> {
        status(unsafe { ffi::av_dict_set(&mut self.0, key.as_ptr(), value.as_ptr(), 0) })
    }
}
impl Drop for Dictionary {
    fn drop(&mut self) {
        unsafe { ffi::av_dict_free(&mut self.0) };
    }
}

struct PathInput {
    format: *mut ffi::AVFormatContext,
    budget: Box<InterruptBudget>,
}
impl Drop for PathInput {
    fn drop(&mut self) {
        unsafe { ffi::avformat_close_input(&mut self.format) };
    }
}
enum Input {
    Memory(MemoryInput),
    Path(PathInput),
}
impl Input {
    fn format(&self) -> *mut ffi::AVFormatContext {
        match self {
            Self::Memory(value) => value.format(),
            Self::Path(value) => value.format,
        }
    }
    fn check(&self) -> Result<(), VideoError> {
        let stopped = match self {
            Self::Memory(value) => value.stopped(),
            Self::Path(value) => value.budget.stopped(),
        };
        if stopped {
            Err(VideoError::Codec(ffi::AVERROR_EXIT))
        } else {
            Ok(())
        }
    }
    fn open(
        source: VideoInput<'_>,
        cancel: VideoCancel,
        max_pixels: u64,
    ) -> Result<Self, VideoError> {
        verify_abi()?;
        if max_pixels == 0 || max_pixels > 268_435_456 {
            return Err(VideoError::Invalid("invalid maxPixels"));
        }
        let value = match source {
            VideoInput::Bytes(bytes) => Self::Memory(
                MemoryInput::from_owned_bytes(bytes, cancel, max_pixels)
                    .map_err(VideoError::Codec)?,
            ),
            VideoInput::Path(path) => {
                if !path.is_absolute() {
                    return Err(VideoError::Invalid("video path must be absolute"));
                }
                let path = path
                    .to_str()
                    .ok_or(VideoError::Invalid("video path must be UTF-8"))?;
                let path = CString::new(path)
                    .map_err(|_| VideoError::Invalid("video path contains NUL"))?;
                let mut input = PathInput {
                    format: unsafe { ffi::avformat_alloc_context() },
                    budget: Box::new(InterruptBudget::new(cancel)),
                };
                if input.format.is_null() {
                    return Err(VideoError::Codec(-12));
                }
                if input.budget.stopped() {
                    return Err(VideoError::Codec(ffi::AVERROR_EXIT));
                }
                let mut options = Dictionary::default();
                options.set(c"protocol_whitelist", c"file")?;
                // SAFETY: the format is uniquely owned and the budget's Box remains pinned through close.
                unsafe {
                    (*input.format).interrupt_callback = ffi::AVIOInterruptCB {
                        callback: Some(crate::memory_io::interrupt),
                        opaque: (&raw mut *input.budget).cast(),
                    };
                    (*input.format).probesize = 8 * 1024 * 1024;
                    (*input.format).max_analyze_duration = 5_000_000;
                    (*input.format).max_streams = 128;
                    (*input.format).max_picture_buffer = MAX_FRAME_BYTES as u32;
                    status(ffi::avformat_open_input(
                        &mut input.format,
                        path.as_ptr(),
                        ptr::null(),
                        &mut options.0,
                    ))?;
                    status(crate::memory_io::find_stream_info(input.format, max_pixels))?;
                }
                Self::Path(input)
            }
        };
        value.check()?;
        Ok(value)
    }
    fn video_stream(&self) -> Result<(i32, &ffi::AVStream), VideoError> {
        self.check()?;
        let index = unsafe {
            ffi::av_find_best_stream(
                self.format(),
                ffi::AVMediaType::AVMEDIA_TYPE_VIDEO,
                -1,
                -1,
                ptr::null_mut(),
                0,
            )
        };
        status(index)?;
        // SAFETY: best_stream returned an index owned by this live format context.
        let stream = unsafe { &*(*self.format()).streams.add(index as usize).read() };
        if stream.codecpar.is_null() {
            return Err(VideoError::Invalid("video has no codec parameters"));
        }
        Ok((index, stream))
    }
}

fn shape(width: i32, height: i32, maximum: u64) -> Result<(u32, u32), VideoError> {
    if maximum == 0
        || maximum > 268_435_456
        || width <= 0
        || height <= 0
        || width as u64 * height as u64 > maximum
    {
        return Err(VideoError::Invalid("video dimensions exceed maxPixels"));
    }
    Ok((width as u32, height as u32))
}
pub fn probe_video(source: VideoInput<'_>, max_pixels: u64) -> Result<VideoMetadata, VideoError> {
    probe_video_with_cancel(source, max_pixels, None)
}
pub fn probe_video_with_cancel(
    source: VideoInput<'_>,
    max_pixels: u64,
    cancel: VideoCancel,
) -> Result<VideoMetadata, VideoError> {
    let input = Input::open(source, cancel, max_pixels)?;
    let (_, stream) = input.video_stream()?;
    let parameters = unsafe { &*stream.codecpar };
    let (width, height) = shape(parameters.width, parameters.height, max_pixels)?;
    let codec = unsafe { ffi::avcodec_get_name(parameters.codec_id) };
    if codec.is_null() {
        return Err(VideoError::Invalid("video codec has no name"));
    }
    let duration = unsafe { (*input.format()).duration };
    Ok(VideoMetadata {
        width,
        height,
        duration_seconds: (duration >= 0).then_some(duration as f64 / 1_000_000.0),
        codec: unsafe { CStr::from_ptr(codec) }
            .to_string_lossy()
            .into_owned(),
    })
}

struct Decoder {
    frame: Frame,
    packet: Packet,
    codec: Codec,
    index: i32,
    base: f64,
    start: f64,
}
impl Decoder {
    fn new(input: &Input, max_pixels: u64) -> Result<Self, VideoError> {
        let (index, stream) = input.video_stream()?;
        let parameters = unsafe { &*stream.codecpar };
        shape(parameters.width, parameters.height, max_pixels)?;
        if stream.time_base.num <= 0 || stream.time_base.den <= 0 {
            return Err(VideoError::Invalid("invalid video timestamp base"));
        }
        let base = f64::from(stream.time_base.num) / f64::from(stream.time_base.den);
        let start = if stream.start_time == ffi::AV_NOPTS_VALUE {
            0.0
        } else {
            stream.start_time as f64 * base
        };
        let descriptor = unsafe { ffi::avcodec_find_decoder(parameters.codec_id) };
        if descriptor.is_null() {
            return Err(VideoError::Codec(ffi::AVERROR_DECODER_NOT_FOUND));
        }
        let codec = Codec::new(descriptor)?;
        // SAFETY: decoder setup precedes opening and the codec is uniquely owned.
        unsafe {
            status(ffi::avcodec_parameters_to_context(codec.0, stream.codecpar))?;
            (*codec.0).thread_count = 1;
            (*codec.0).max_pixels = max_pixels as i64;
            status(ffi::avcodec_open2(codec.0, descriptor, ptr::null_mut()))?;
        }
        Ok(Self {
            codec,
            packet: Packet::new()?,
            frame: Frame::new()?,
            index,
            base,
            start,
        })
    }
    fn walk(
        &mut self,
        input: &Input,
        maximum: u64,
        mut consume: impl FnMut(&ffi::AVFrame, Option<f64>) -> Result<bool, VideoError>,
    ) -> Result<(), VideoError> {
        let mut packets = 0;
        let mut frames = 0;
        let mut pending = false;
        let mut eof = false;
        let mut flushed = false;
        loop {
            input.check()?;
            let result = unsafe { ffi::avcodec_receive_frame(self.codec.0, self.frame.0) };
            if result >= 0 {
                frames += 1;
                if frames > MAX_FRAMES {
                    return Err(VideoError::Invalid("video exceeds the frame limit"));
                }
                let frame = unsafe { &*self.frame.0 };
                shape(frame.width, frame.height, maximum)?;
                let timestamp = (frame.best_effort_timestamp != ffi::AV_NOPTS_VALUE)
                    .then_some(frame.best_effort_timestamp as f64 * self.base - self.start);
                let stop = consume(frame, timestamp)?;
                unsafe { ffi::av_frame_unref(self.frame.0) };
                if stop {
                    return Ok(());
                }
                continue;
            }
            if result == ffi::AVERROR_EOF {
                return Ok(());
            }
            if result != AGAIN {
                return Err(VideoError::Codec(result));
            }
            if !pending && !eof {
                unsafe { ffi::av_packet_unref(self.packet.0) };
                let result = unsafe { ffi::av_read_frame(input.format(), self.packet.0) };
                if result == ffi::AVERROR_EOF {
                    eof = true;
                } else {
                    status(result)?;
                    packets += 1;
                    if packets > MAX_PACKETS {
                        return Err(VideoError::Invalid("video exceeds the packet limit"));
                    }
                    if unsafe { (*self.packet.0).stream_index } != self.index {
                        continue;
                    }
                    pending = true;
                }
            }
            if pending {
                let result = unsafe { ffi::avcodec_send_packet(self.codec.0, self.packet.0) };
                if result == AGAIN {
                    return Err(VideoError::Invalid("decoder made no send/receive progress"));
                }
                status(result)?;
                pending = false;
                unsafe { ffi::av_packet_unref(self.packet.0) };
            } else if eof && !flushed {
                let result = unsafe { ffi::avcodec_send_packet(self.codec.0, ptr::null()) };
                if result != ffi::AVERROR_EOF {
                    status(result)?;
                }
                flushed = true;
            } else {
                return Err(VideoError::Invalid("decoder made no drain progress"));
            }
        }
    }
}

unsafe extern "C" {
    // C accepts the pixel enum as an int. Keep AVFrame.format as an int until libswscale validates it.
    #[link_name = "sws_getContext"]
    fn sws_context(
        width: i32,
        height: i32,
        format: i32,
        out_width: i32,
        out_height: i32,
        out_format: i32,
        flags: i32,
        src: *mut ffi::SwsFilter,
        dst: *mut ffi::SwsFilter,
        param: *const f64,
    ) -> *mut ffi::SwsContext;
}
struct Scaler(*mut ffi::SwsContext);
impl Drop for Scaler {
    fn drop(&mut self) {
        unsafe { ffi::sws_freeContext(self.0) };
    }
}
fn rgba(frame: &ffi::AVFrame) -> Result<Vec<u8>, VideoError> {
    let row = usize::try_from(frame.width)
        .map_err(|_| VideoError::Invalid("invalid RGBA width"))?
        .checked_mul(4)
        .ok_or(VideoError::Invalid("RGBA width overflow"))?;
    let size = row
        .checked_mul(frame.height as usize)
        .filter(|size| *size <= MAX_FRAME_BYTES)
        .ok_or(VideoError::Invalid("RGBA frame exceeds byte limit"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| VideoError::Codec(-12))?;
    bytes.resize(size, 0);
    let scaler = Scaler(unsafe {
        sws_context(
            frame.width,
            frame.height,
            frame.format,
            frame.width,
            frame.height,
            ffi::AVPixelFormat::AV_PIX_FMT_RGBA as i32,
            ffi::SwsFlags::SWS_BILINEAR as i32,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
        )
    });
    if scaler.0.is_null() {
        return Err(VideoError::Invalid("unsupported decoded pixel format"));
    }
    let mut planes = [ptr::null_mut(); 4];
    planes[0] = bytes.as_mut_ptr();
    let strides = [
        i32::try_from(row).map_err(|_| VideoError::Invalid("RGBA row exceeds stride range"))?,
        0,
        0,
        0,
    ];
    // SAFETY: FFmpeg owns every source plane; the destination is initialized and sized for all RGBA rows.
    let rows = unsafe {
        ffi::sws_scale(
            scaler.0,
            frame.data.as_ptr().cast(),
            frame.linesize.as_ptr(),
            0,
            frame.height,
            planes.as_ptr(),
            strides.as_ptr(),
        )
    };
    if rows != frame.height {
        return Err(VideoError::Invalid("incomplete RGBA conversion"));
    }
    Ok(bytes)
}
pub fn decode_video_frame(
    source: VideoInput<'_>,
    time_seconds: f64,
    max_pixels: u64,
) -> Result<DecodedVideoFrame, VideoError> {
    decode_video_frame_with_cancel(source, time_seconds, max_pixels, None)
}
pub fn decode_video_frame_with_cancel(
    source: VideoInput<'_>,
    time_seconds: f64,
    max_pixels: u64,
    cancel: VideoCancel,
) -> Result<DecodedVideoFrame, VideoError> {
    if !time_seconds.is_finite()
        || time_seconds < 0.0
        || time_seconds > i64::MAX as f64 / 1_000_000.0
    {
        return Err(VideoError::Invalid(
            "frame time must be a finite nonnegative number",
        ));
    }
    let input = Input::open(source, cancel, max_pixels)?;
    let mut decoder = Decoder::new(&input, max_pixels)?;
    if time_seconds > 0.0 {
        let timestamp = (time_seconds + decoder.start) * 1_000_000.0;
        if !timestamp.is_finite() || timestamp >= i64::MAX as f64 || timestamp < i64::MIN as f64 {
            return Err(VideoError::Invalid("frame time exceeds timestamp range"));
        }
        status(unsafe {
            ffi::avformat_seek_file(
                input.format(),
                -1,
                i64::MIN,
                timestamp as i64,
                timestamp as i64,
                0,
            )
        })?;
        unsafe { ffi::avcodec_flush_buffers(decoder.codec.0) };
        status(unsafe { ffi::avformat_flush(input.format()) })?;
    }
    let mut selected = None;
    decoder.walk(&input, max_pixels, |frame, timestamp| {
        if timestamp.is_some_and(|value| value < time_seconds) {
            return Ok(false);
        }
        if time_seconds > 0.0 && timestamp.is_none() {
            return Err(VideoError::Invalid("video frame has no timestamp"));
        }
        let pixels = rgba(frame)?;
        selected = Some(DecodedVideoFrame {
            width: frame.width as u32,
            height: frame.height as u32,
            timestamp_seconds: timestamp,
            png: crate::encode_rgba_png(frame.width as u32, frame.height as u32, &pixels)?,
        });
        Ok(true)
    })?;
    selected.ok_or(VideoError::Invalid(
        "no video frame exists at the selected time",
    ))
}

fn png_frame(
    input: &mut impl std::io::Read,
) -> Result<(u32, u32, Vec<u8>), Box<dyn std::error::Error>> {
    let mut signature = [0; 8];
    input.read_exact(&mut signature)?;
    if &signature != b"\x89PNG\r\n\x1a\n" {
        return Err("invalid PNG frame signature".into());
    }
    let mut encoded = signature.to_vec();
    loop {
        let mut header = [0; 8];
        input.read_exact(&mut header)?;
        let length = u32::from_be_bytes(header[..4].try_into()?) as usize;
        let end = encoded
            .len()
            .checked_add(length)
            .and_then(|n| n.checked_add(12))
            .filter(|size| *size <= MAX_FRAME_BYTES)
            .ok_or("PNG frame exceeds byte limit")?;
        encoded.extend_from_slice(&header);
        let start = encoded.len();
        encoded.resize(end, 0);
        input.read_exact(&mut encoded[start..])?;
        if &header[4..] == b"IEND" {
            break;
        }
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(encoded));
    decoder.set_limits(png::Limits {
        bytes: MAX_FRAME_BYTES,
    });
    let mut reader = decoder.read_info()?;
    let size = reader.output_buffer_size();
    if size > MAX_FRAME_BYTES {
        return Err("PNG output exceeds byte limit".into());
    }
    let mut bytes = vec![0; size];
    let frame = reader.next_frame(&mut bytes)?;
    if frame.color_type != png::ColorType::Rgba || frame.bit_depth != png::BitDepth::Eight {
        return Err("native encoding requires 8-bit RGBA PNG frames".into());
    }
    bytes.truncate(frame.buffer_size());
    reader.finish()?;
    Ok((frame.width, frame.height, bytes))
}

struct Output {
    format: *mut ffi::AVFormatContext,
    io: *mut ffi::AVIOContext,
    target: *mut WriteTarget,
    pending_buffer: *mut u8,
}
struct WriteTarget {
    file: std::fs::File,
    budget: InterruptBudget,
}
unsafe extern "C" fn write_output(
    opaque: *mut std::ffi::c_void,
    data: *const u8,
    size: i32,
) -> i32 {
    if opaque.is_null() || data.is_null() || size <= 0 {
        return -22;
    }
    // SAFETY: the output owner pins WriteTarget and FFmpeg supplies size readable bytes.
    let target = unsafe { &mut *opaque.cast::<WriteTarget>() };
    if target.budget.stopped() {
        return ffi::AVERROR_EXIT;
    }
    match target
        .file
        .write_all(unsafe { std::slice::from_raw_parts(data, size as usize) })
    {
        Ok(()) => size,
        Err(_) => -5,
    }
}
unsafe extern "C" fn seek_output(opaque: *mut std::ffi::c_void, offset: i64, whence: i32) -> i64 {
    use std::io::{Seek, SeekFrom};
    if opaque.is_null() {
        return -22;
    }
    let target = unsafe { &mut *opaque.cast::<WriteTarget>() };
    if target.budget.stopped() {
        return i64::from(ffi::AVERROR_EXIT);
    }
    if whence & ffi::AVSEEK_SIZE != 0 {
        return target
            .file
            .metadata()
            .ok()
            .and_then(|value| i64::try_from(value.len()).ok())
            .unwrap_or(-5);
    }
    let from = match whence & !ffi::AVSEEK_FORCE {
        0 if offset >= 0 => SeekFrom::Start(offset as u64),
        1 => SeekFrom::Current(offset),
        2 => SeekFrom::End(offset),
        _ => return -22,
    };
    target
        .file
        .seek(from)
        .ok()
        .and_then(|value| i64::try_from(value).ok())
        .unwrap_or(-5)
}
impl Output {
    fn new(path: &Path, budget: InterruptBudget) -> Result<Self, VideoError> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        let mut output = Self {
            format: ptr::null_mut(),
            io: ptr::null_mut(),
            target: Box::into_raw(Box::new(WriteTarget { file, budget })),
            pending_buffer: ptr::null_mut(),
        };
        // SAFETY: allocation failures unwind through this owner; the pinned target remains alive through every callback.
        unsafe {
            status(ffi::avformat_alloc_output_context2(
                &mut output.format,
                ptr::null(),
                c"matroska".as_ptr(),
                ptr::null(),
            ))?;
            if output.format.is_null() {
                return Err(VideoError::Codec(-12));
            }
            output.pending_buffer = ffi::av_malloc(32768).cast();
            if output.pending_buffer.is_null() {
                return Err(VideoError::Codec(-12));
            }
            output.io = ffi::avio_alloc_context(
                output.pending_buffer,
                32768,
                1,
                output.target.cast(),
                None,
                Some(write_output),
                Some(seek_output),
            );
            if output.io.is_null() {
                return Err(VideoError::Codec(-12));
            }
            output.pending_buffer = ptr::null_mut();
            (*output.format).pb = output.io;
            (*output.format).flags |= ffi::AVFMT_FLAG_CUSTOM_IO;
        }
        Ok(output)
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        unsafe {
            if !self.io.is_null() {
                ffi::avio_flush(self.io);
            }
            if !self.format.is_null() {
                ffi::avformat_free_context(self.format);
            }
            if !self.io.is_null() {
                ffi::av_free((*self.io).buffer.cast());
                (*self.io).buffer = ptr::null_mut();
                ffi::avio_context_free(&mut self.io);
            }
            ffi::av_free(self.pending_buffer.cast());
            if !self.target.is_null() {
                drop(Box::from_raw(self.target));
            }
        }
    }
}
pub fn encoder_present(name: &str) -> Result<bool, VideoError> {
    verify_abi()?;
    let name = CString::new(name).map_err(|_| VideoError::Invalid("invalid encoder name"))?;
    Ok(!unsafe { ffi::avcodec_find_encoder_by_name(name.as_ptr()) }.is_null())
}
fn drain_encoder(
    codec: &Codec,
    packet: &Packet,
    output: &Output,
    source_base: ffi::AVRational,
    target_base: ffi::AVRational,
    count: &mut usize,
) -> Result<bool, VideoError> {
    for _ in 0..=MAX_PACKETS {
        let code = unsafe { ffi::avcodec_receive_packet(codec.0, packet.0) };
        if code == AGAIN {
            return Ok(false);
        }
        if code == ffi::AVERROR_EOF {
            return Ok(true);
        }
        status(code)?;
        *count += 1;
        if *count > MAX_PACKETS {
            return Err(VideoError::Invalid("encoder exceeds total packet limit"));
        }
        unsafe {
            (*packet.0).stream_index = 0;
            ffi::av_packet_rescale_ts(packet.0, source_base, target_base);
            status(ffi::av_interleaved_write_frame(output.format, packet.0))?;
            ffi::av_packet_unref(packet.0);
        }
    }
    Err(VideoError::Invalid("encoder exceeds packet drain limit"))
}
pub fn encode_ffv1(
    input: &mut impl std::io::BufRead,
    output: &Path,
    options: &crate::EncodeOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    verify_abi()?;
    options.args(output)?;
    if options.backend != crate::Backend::Ffv1 || options.frames > MAX_FRAMES as u64 {
        return Err("native FFV1 encoder requires ffv1 and at most 100000 frames".into());
    }
    let budget = InterruptBudget::new(None);
    let first = png_frame(input)?;
    let (width, height) = shape(
        i32::try_from(first.0)?,
        i32::try_from(first.1)?,
        (MAX_FRAME_BYTES / 4) as u64,
    )?;
    let descriptor = unsafe { ffi::avcodec_find_encoder(ffi::AVCodecID::AV_CODEC_ID_FFV1) };
    if descriptor.is_null() {
        return Err(VideoError::Codec(ffi::AVERROR_ENCODER_NOT_FOUND).into());
    }
    let codec = Codec::new(descriptor)?;
    let time_base = ffi::AVRational {
        num: i32::try_from(options.fps.den)?,
        den: i32::try_from(options.fps.num)?,
    };
    let mut settings = Dictionary::default();
    settings.set(c"level", c"3")?;
    settings.set(c"slicecrc", c"1")?;
    unsafe {
        (*codec.0).width = width as i32;
        (*codec.0).height = height as i32;
        (*codec.0).pix_fmt = ffi::AVPixelFormat::AV_PIX_FMT_BGRA;
        (*codec.0).time_base = time_base;
        (*codec.0).thread_count = options.threads as i32;
        (*codec.0).flags |= ffi::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
        status(ffi::avcodec_open2(codec.0, descriptor, &mut settings.0))?;
    }
    let container = Output::new(output, budget.clone())?;
    unsafe {
        let stream = ffi::avformat_new_stream(container.format, descriptor);
        if stream.is_null() {
            return Err(VideoError::Codec(-12).into());
        }
        (*stream).time_base = time_base;
        status(ffi::avcodec_parameters_from_context(
            (*stream).codecpar,
            codec.0,
        ))?;
        status(ffi::avformat_write_header(
            container.format,
            ptr::null_mut(),
        ))?;
    }
    let output_base = unsafe { (**(*container.format).streams).time_base };
    let packet = Packet::new()?;
    let frame = Frame::new()?;
    unsafe {
        (*frame.0).format = ffi::AVPixelFormat::AV_PIX_FMT_BGRA as i32;
        (*frame.0).width = width as i32;
        (*frame.0).height = height as i32;
        status(ffi::av_frame_get_buffer(frame.0, 32))?;
    }
    let mut next = Some(first);
    let mut packet_count = 0;
    for index in 0..options.frames {
        if budget.stopped() {
            return Err(VideoError::Codec(ffi::AVERROR_EXIT).into());
        }
        let (w, h, bytes) = match next.take() {
            Some(first) => first,
            None => png_frame(input)?,
        };
        if (w, h) != (width, height) {
            return Err("PNG dimensions changed during encoding".into());
        }
        unsafe {
            status(ffi::av_frame_make_writable(frame.0))?;
            (*frame.0).pts = index as i64;
            let stride = usize::try_from((*frame.0).linesize[0])?;
            let row = width as usize * 4;
            if stride < row || (*frame.0).data[0].is_null() {
                return Err("invalid encoder frame plane".into());
            }
            for y in 0..height as usize {
                let dest = std::slice::from_raw_parts_mut((*frame.0).data[0].add(y * stride), row);
                for (rgba, bgra) in bytes[y * row..(y + 1) * row]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(dest.as_chunks_mut::<4>().0.iter_mut())
                {
                    bgra.copy_from_slice(&[rgba[2], rgba[1], rgba[0], rgba[3]]);
                }
            }
            status(ffi::avcodec_send_frame(codec.0, frame.0))?;
        }
        drain_encoder(
            &codec,
            &packet,
            &container,
            time_base,
            output_base,
            &mut packet_count,
        )?;
    }
    if !input.fill_buf()?.is_empty() {
        return Err("More PNG frames than the declared frame count".into());
    }
    status(unsafe { ffi::avcodec_send_frame(codec.0, ptr::null()) })?;
    if !drain_encoder(
        &codec,
        &packet,
        &container,
        time_base,
        output_base,
        &mut packet_count,
    )? {
        return Err(VideoError::Invalid("encoder did not complete EOF drain").into());
    }
    status(unsafe { ffi::av_write_trailer(container.format) })?;
    unsafe { ffi::avio_flush(container.io) };
    status(unsafe { (*container.io).error })?;
    Ok(())
}
pub fn decode_rgba(
    path: &Path,
    output: &mut impl Write,
) -> Result<u64, Box<dyn std::error::Error>> {
    let maximum = (MAX_FRAME_BYTES / 4) as u64;
    let input = Input::open(VideoInput::Path(path), None, maximum)?;
    let mut decoder = Decoder::new(&input, maximum)?;
    let mut count = 0;
    decoder.walk(&input, maximum, |frame, _| {
        output.write_all(&rgba(frame)?)?;
        count += 1;
        Ok(false)
    })?;
    Ok(count)
}

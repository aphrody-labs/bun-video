//! Pure-Rust MP4 probing, bounded decoded-frame sessions and lossless access-unit remuxing.
//! Container parsing and colour conversion remain owned by the pinned FilmCraft crates.

use filmcraft_codecs::video::VideoDecoder;
use filmcraft_frame::VideoFrame;
use filmcraft_isobmff::{ByteSource, Mp4File, Mp4Writer, TrackKind, WriteSample};
use filmcraft_lib::Demuxer;
use filmcraft_media::{SharedReader, SharedSource, reader::MemReader};
use filmcraft_time::Tick;
use std::{
    collections::BTreeMap,
    io,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_MEMORY_BYTES: usize = 256 * 1024 * 1024;
const MAX_PATH_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_READ_BYTES: usize = 32 * 1024 * 1024;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CACHE_FRAMES: usize = 16;
const MAX_SAMPLES: usize = 1_000_000;

pub enum VideoInput<'a> {
    Path(&'a Path),
    Bytes(Arc<[u8]>),
}

#[derive(Debug)]
pub enum VideoError {
    Invalid(&'static str),
    Owner(String),
    Io(io::Error),
    Cancelled,
}
impl std::fmt::Display for VideoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(s) => f.write_str(s),
            Self::Owner(s) => f.write_str(s),
            Self::Io(e) => e.fmt(f),
            Self::Cancelled => f.write_str("video operation cancelled"),
        }
    }
}
impl std::error::Error for VideoError {}
impl From<io::Error> for VideoError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
fn owner(error: impl std::fmt::Display) -> VideoError {
    VideoError::Owner(error.to_string())
}

#[derive(Debug, Clone)]
pub struct VideoMetadata {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: Option<f64>,
    pub codec: String,
    pub fps_numerator: i64,
    pub fps_denominator: i64,
    pub container: String,
    pub file_bytes: u64,
    pub frame_count: u64,
    pub audio_streams: Vec<AudioStreamMetadata>,
}
#[derive(Debug, Clone)]
pub struct AudioStreamMetadata {
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
}
pub struct DecodedVideoFrame {
    pub width: u32,
    pub height: u32,
    pub timestamp_seconds: Option<f64>,
    pub png: Vec<u8>,
}
pub struct DecodedRGBAFrame {
    pub width: u32,
    pub height: u32,
    pub timestamp_seconds: f64,
    pub rgba: Vec<u8>,
}
pub type VideoCancel = Option<Arc<AtomicBool>>;

#[cfg(feature = "filmcraft-encode")]
pub use encoding::VideoEncoderSession;

/// Bounded RGBA stream export through the existing FilmCraft encoder, without a media subprocess.
#[cfg(feature = "filmcraft-encode")]
pub fn encode_rgba_stream(
    input: &mut impl std::io::Read,
    output: &Path,
    width: u32,
    height: u32,
    fps: filmcraft_lib::FrameRate,
    frames: usize,
) -> Result<u64, VideoError> {
    use std::io::Write;
    if !output.is_absolute() || output.exists() {
        return Err(VideoError::Invalid("encoding requires a new absolute output path"));
    }
    if fps.num <= 0 || fps.den <= 0 || i128::from(fps.num) > i128::from(fps.den) * 240 {
        return Err(VideoError::Invalid("encoding requires a positive rational FPS at most 240"));
    }
    if frames == 0 || frames > 10_000 {
        return Err(VideoError::Invalid("encoding requires 1..10000 frames"));
    }
    dimensions(width, height, (MAX_MEMORY_BYTES / 4) as u64)?;
    let frame_bytes = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(VideoError::Invalid("encoding frame size overflow"))?;
    let input_bytes = frame_bytes.checked_mul(frames)
        .filter(|bytes| *bytes <= MAX_MEMORY_BYTES)
        .ok_or(VideoError::Invalid("encoding input exceeds the 256 MiB job budget"))?;
    let options = filmcraft_lib::EncoderOptions::new(Some(filmcraft_lib::VideoOptions::new(
        filmcraft_lib::VideoCodec::H264, width, height, fps,
    )), None);
    let mut encoder = VideoEncoderSession::new(options, input_bytes, MAX_MEMORY_BYTES, None)?;
    let mut pixels = vec![0; frame_bytes];
    for _ in 0..frames {
        input.read_exact(&mut pixels)?;
        encoder.push_rgba(&pixels)?;
    }
    if input.read(&mut [0; 1])? != 0 {
        return Err(VideoError::Invalid("encoding input contains more than the declared frames"));
    }
    let (bytes, report) = encoder.finish()?;
    if report.video_frames != frames as u64 {
        return Err(VideoError::Invalid("encoder frame count does not match the input"));
    }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(output)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(bytes.len() as u64)
    })();
    if result.is_err() { std::fs::remove_file(output)?; }
    result
}

#[cfg(feature = "filmcraft-encode")]
mod encoding {
    use super::*;
    use std::io::{Cursor, Read, Seek, SeekFrom, Write};

    const ENCODE_DEADLINE: Duration = Duration::from_secs(180);
    const MAX_ENCODE_FRAMES: usize = 10_000;

    struct Output {
        bytes: Cursor<Vec<u8>>,
        limit: usize,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    }

    impl Output {
        fn check(&self) -> io::Result<()> {
            if self.cancel.load(Ordering::Acquire) {
                // write_all/read_exact retry Interrupted, so cancellation must be terminal I/O.
                return Err(io::Error::other("video encoding cancelled"));
            }
            if Instant::now() >= self.deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "video encoding exceeded its deadline",
                ));
            }
            Ok(())
        }
    }
    impl Read for Output {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.check()?;
            self.bytes.read(buffer)
        }
    }
    impl Write for Output {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.check()?;
            let end = self
                .bytes
                .position()
                .checked_add(buffer.len() as u64)
                .ok_or_else(|| io::Error::other("encoded video size overflow"))?;
            if end > self.limit as u64 {
                return Err(io::Error::other("encoded video exceeds output budget"));
            }
            let bytes = self.bytes.get_mut();
            if end as usize > bytes.capacity() {
                bytes
                    .try_reserve_exact(end as usize - bytes.len())
                    .map_err(|_| io::Error::other("encoded video allocation failed"))?;
            }
            self.bytes.write(buffer)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.check()
        }
    }
    impl Seek for Output {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.check()?;
            let next = match position {
                SeekFrom::Start(value) => i128::from(value),
                SeekFrom::Current(value) => i128::from(self.bytes.position()) + i128::from(value),
                SeekFrom::End(value) => self.bytes.get_ref().len() as i128 + i128::from(value),
            };
            if next < 0 || next > self.limit as i128 {
                return Err(io::Error::other("encoded video seek exceeds output budget"));
            }
            self.bytes.seek(SeekFrom::Start(next as u64))
        }
    }

    /// Owns the pure-Rust codec state; drop or any owner error discards the partial container.
    /// Limits apply to cumulative RGBA/PCM input and the seekable output, each at most 256 MiB.
    /// Cancellation is observed between codec calls and on every container read/write/seek.
    pub struct VideoEncoderSession {
        encoder: Option<filmcraft_lib::Encoder<Output>>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        input_limit: usize,
        input_bytes: usize,
        frame_bytes: Option<usize>,
        audio_channels: Option<usize>,
        frames: usize,
    }

    impl VideoEncoderSession {
        pub fn new(
            mut options: filmcraft_lib::EncoderOptions,
            input_limit: usize,
            output_limit: usize,
            cancel: VideoCancel,
        ) -> Result<Self, VideoError> {
            if input_limit == 0
                || input_limit > MAX_MEMORY_BYTES
                || output_limit == 0
                || output_limit > MAX_MEMORY_BYTES
            {
                return Err(VideoError::Invalid(
                    "encoding budgets must be between 1 byte and 256 MiB",
                ));
            }
            let frame_bytes = if let Some(video) = &options.video {
                dimensions(video.width, video.height, (input_limit / 4) as u64)?;
                Some(video.width as usize * video.height as usize * 4)
            } else {
                None
            };
            options.limits.max_frame_pixels = options
                .limits
                .max_frame_pixels
                .min((input_limit / 4) as u64);
            let audio_channels = options.audio.as_ref().map(|audio| audio.channels as usize);
            let cancel = cancel.unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
            if cancel.load(Ordering::Acquire) {
                return Err(VideoError::Cancelled);
            }
            let deadline = Instant::now() + ENCODE_DEADLINE;
            let output = Output {
                bytes: Cursor::new(Vec::new()),
                limit: output_limit,
                cancel: Arc::clone(&cancel),
                deadline,
            };
            let encoder = filmcraft_lib::Encoder::new(output, options).map_err(owner)?;
            Ok(Self {
                encoder: Some(encoder),
                cancel,
                deadline,
                input_limit,
                input_bytes: 0,
                frame_bytes,
                audio_channels,
                frames: 0,
            })
        }

        fn check(&mut self) -> Result<(), VideoError> {
            if self.cancel.load(Ordering::Acquire) {
                self.encoder = None;
                return Err(VideoError::Cancelled);
            }
            if Instant::now() >= self.deadline {
                self.encoder = None;
                return Err(VideoError::Invalid("video encoding exceeded its deadline"));
            }
            if self.encoder.is_none() {
                return Err(VideoError::Invalid(
                    "video encoder is closed after an error",
                ));
            }
            Ok(())
        }

        fn reserve_input(&self, bytes: usize) -> Result<usize, VideoError> {
            let total = self
                .input_bytes
                .checked_add(bytes)
                .ok_or(VideoError::Invalid("encoding input budget overflow"))?;
            if total > self.input_limit {
                return Err(VideoError::Invalid(
                    "encoding exceeds cumulative input budget",
                ));
            }
            Ok(total)
        }

        fn push(
            &mut self,
            bytes: usize,
            f: impl FnOnce(&mut filmcraft_lib::Encoder<Output>) -> filmcraft_lib::Result<()>,
        ) -> Result<(), VideoError> {
            self.check()?;
            let total = self.reserve_input(bytes)?;
            let mut encoder = self
                .encoder
                .take()
                .ok_or(VideoError::Invalid("video encoder is closed"))?;
            let result = f(&mut encoder);
            // Check cancellation before restoring state so failed or interrupted sessions cannot finish.
            if self.cancel.load(Ordering::Acquire) {
                return Err(VideoError::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Err(VideoError::Invalid("video encoding exceeded its deadline"));
            }
            result.map_err(owner)?;
            self.input_bytes = total;
            self.encoder = Some(encoder);
            Ok(())
        }

        /// Straight-alpha RGBA8. Lossy profiles may discard alpha according to the selected codec.
        pub fn push_rgba(&mut self, rgba: &[u8]) -> Result<(), VideoError> {
            if self.frame_bytes != Some(rgba.len()) {
                return Err(VideoError::Invalid(
                    "encoding RGBA size must match the configured video track",
                ));
            }
            if self.frames >= MAX_ENCODE_FRAMES {
                return Err(VideoError::Invalid("encoding exceeds 10000 frames"));
            }
            self.push(rgba.len(), |encoder| encoder.push_rgba(rgba))?;
            self.frames += 1;
            Ok(())
        }

        /// Planar finite PCM samples in -1..1, with the configured channel count and equal lengths.
        pub fn push_audio(&mut self, planar: &[Vec<f32>]) -> Result<(), VideoError> {
            if self.audio_channels != Some(planar.len()) || planar.is_empty() {
                return Err(VideoError::Invalid(
                    "encoding PCM channel count must match the audio track",
                ));
            }
            let samples = planar[0].len();
            let bytes = samples
                .checked_mul(planar.len())
                .and_then(|n| n.checked_mul(4))
                .ok_or(VideoError::Invalid("encoding PCM size overflow"))?;
            self.check()?;
            self.reserve_input(bytes)?;
            if planar.iter().any(|channel| {
                channel.len() != samples
                    || channel
                        .iter()
                        .any(|sample| !sample.is_finite() || !(-1.0..=1.0).contains(sample))
            }) {
                return Err(VideoError::Invalid(
                    "encoding PCM needs equal channel lengths and finite samples in -1..1",
                ));
            }
            self.push(bytes, |encoder| encoder.push_audio(planar))
        }

        pub fn cancel(&mut self) {
            self.cancel.store(true, Ordering::Release);
            self.encoder = None;
        }

        pub fn finish(mut self) -> Result<(Vec<u8>, filmcraft_lib::EncodeReport), VideoError> {
            self.check()?;
            let encoder = self
                .encoder
                .take()
                .ok_or(VideoError::Invalid("video encoder is closed"))?;
            let control = filmcraft_lib::Control::new().with_deadline(self.deadline);
            let result = encoder.finish(&control);
            if self.cancel.load(Ordering::Acquire) {
                return Err(VideoError::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Err(VideoError::Invalid("video encoding exceeded its deadline"));
            }
            let (output, report) = result.map_err(owner)?;
            Ok((output.bytes.into_inner(), report))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn output_bounds_sparse_writes_and_uses_terminal_cancellation_errors() {
            let cancel = Arc::new(AtomicBool::new(false));
            let mut output = Output {
                bytes: Cursor::new(Vec::new()),
                limit: 8,
                cancel: Arc::clone(&cancel),
                deadline: Instant::now() + ENCODE_DEADLINE,
            };
            output.seek(SeekFrom::Start(7)).unwrap();
            output.write_all(&[42]).unwrap();
            assert_eq!(output.bytes.get_ref(), &[0, 0, 0, 0, 0, 0, 0, 42]);
            assert!(output.write(&[1]).is_err());
            assert!(output.seek(SeekFrom::End(1)).is_err());
            assert!(output.seek(SeekFrom::Start(u64::MAX)).is_err());
            cancel.store(true, Ordering::Release);
            assert_eq!(output.write(&[1]).unwrap_err().kind(), io::ErrorKind::Other);
            assert_eq!(
                output.read(&mut [0]).unwrap_err().kind(),
                io::ErrorKind::Other
            );
            assert_eq!(
                output.seek(SeekFrom::Start(0)).unwrap_err().kind(),
                io::ErrorKind::Other
            );
        }
    }
}

/// Limits every owner's individual range request, including moov/moof header allocations.
struct BoundedReader(SharedReader);
impl filmcraft_media::ByteReader for BoundedReader {
    fn len(&self) -> u64 {
        self.0.len()
    }
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        if buffer.len() > MAX_READ_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "video range exceeds 32 MiB",
            ));
        }
        self.0.read_at(offset, buffer)
    }
}
struct IsoReader(SharedReader);
impl ByteSource for IsoReader {
    fn len(&self) -> u64 {
        self.0.len()
    }
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        self.0.read_at(offset, buffer)
    }
}

/// The same handle is statted and read; replacing the pathname cannot change this source.
struct OpenedFileReader {
    file: std::fs::File,
    bytes: u64,
}
impl filmcraft_media::ByteReader for OpenedFileReader {
    fn len(&self) -> u64 {
        self.bytes
    }
    fn read_at(&self, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
        ByteSource::read_at(&self.file, offset, buffer)
    }
}

fn input_path(path_utf8: &[u8]) -> Result<std::path::PathBuf, VideoError> {
    let path = std::str::from_utf8(path_utf8)
        .map_err(|_| VideoError::Invalid("video path must be UTF-8"))?;
    Ok(std::fs::canonicalize(path)?)
}

fn dimensions(width: u32, height: u32, max_pixels: u64) -> Result<(), VideoError> {
    let pixels = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or(VideoError::Invalid("video dimensions overflow"))?;
    if max_pixels == 0
        || max_pixels > (MAX_MEMORY_BYTES / 4) as u64
        || pixels == 0
        || pixels > max_pixels
    {
        return Err(VideoError::Invalid(
            "video dimensions exceed the pixel budget",
        ));
    }
    Ok(())
}

fn reader(input: VideoInput<'_>) -> Result<SharedReader, VideoError> {
    let inner: SharedReader = match input {
        VideoInput::Path(path) => {
            if !path.is_absolute() {
                return Err(VideoError::Invalid("video input path must be absolute"));
            }
            let file = std::fs::File::open(path)?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PATH_BYTES {
                return Err(VideoError::Invalid(
                    "video input must be a regular nonempty file at most 64 GiB",
                ));
            }
            Arc::new(OpenedFileReader {
                file,
                bytes: metadata.len(),
            })
        }
        VideoInput::Bytes(bytes) => {
            if bytes.is_empty() || <[u8]>::len(&bytes) > MAX_MEMORY_BYTES {
                return Err(VideoError::Invalid(
                    "in-memory video must be nonempty and at most 256 MiB",
                ));
            }
            Arc::new(MemReader(bytes))
        }
    };
    Ok(Arc::new(BoundedReader(inner)))
}

fn demux_limits() -> filmcraft_lib::Limits {
    let mut limits = filmcraft_lib::Limits::default();
    limits.max_input_bytes = MAX_PATH_BYTES;
    limits
}

/// Matroska and WebM carry an exact packet table; other containers fall back to duration times rate.
fn exact_packet_frames(demuxer: filmcraft_lib::Result<Demuxer>) -> Option<u64> {
    let demuxer = demuxer.ok()?;
    let track = demuxer.first_track(filmcraft_lib::TrackKind::Video)?;
    demuxer.tracks().get(track).map(|info| info.packets)
}

fn open(
    input: VideoInput<'_>,
    max_pixels: u64,
) -> Result<(SharedReader, SharedSource, VideoMetadata), VideoError> {
    if max_pixels == 0 || max_pixels > (MAX_MEMORY_BYTES / 4) as u64 {
        return Err(VideoError::Invalid("invalid pixel budget"));
    }
    let packet_frames = match &input {
        VideoInput::Path(path) => exact_packet_frames(Demuxer::open_path(path, &demux_limits())),
        VideoInput::Bytes(bytes) => {
            exact_packet_frames(Demuxer::open_bytes(Arc::clone(bytes), &demux_limits()))
        }
    };
    let reader = reader(input)?;
    // ISO base media keeps the budgeted sample-table path; other containers use FilmCraft owners.
    let indexed_frames = if is_iso_base_media(&*reader) {
        let mp4 = validated_mp4(Arc::clone(&reader))?;
        Some(
            mp4.tracks
                .iter()
                .find(|track| track.kind == TrackKind::Video && !track.samples.is_empty())
                .ok_or(VideoError::Invalid("MP4 has no video samples"))?
                .samples
                .len() as u64,
        )
    } else {
        None
    };
    // A path is never read whole: only owners supporting random-access readers are admitted.
    let source = filmcraft_media::reader::open_reader_within(
        "bun-video.media",
        Arc::clone(&reader),
        &filmcraft_codecs::reader_openers(),
        &[],
        0,
    )
    .map_err(owner)?;
    let info = source.info();
    let video = info
        .video
        .as_ref()
        .ok_or(VideoError::Invalid("source has no video stream"))?;
    dimensions(video.width, video.height, max_pixels)?;
    if video.frame_rate.num <= 0 || video.frame_rate.den <= 0 {
        return Err(VideoError::Invalid("invalid source frame rate"));
    }
    let frame_count = indexed_frames.or(packet_frames).unwrap_or_else(|| {
        let seconds = info.duration.seconds();
        let rate = video.frame_rate.num as f64 / video.frame_rate.den as f64;
        if seconds.is_finite() && seconds > 0.0 {
            (seconds * rate).round().max(1.0) as u64
        } else {
            0
        }
    });
    let metadata = VideoMetadata {
        width: video.width,
        height: video.height,
        duration_seconds: Some(info.duration.seconds()),
        codec: video.codec.clone(),
        fps_numerator: video.frame_rate.num,
        fps_denominator: video.frame_rate.den,
        container: info.container.clone(),
        file_bytes: reader.len(),
        frame_count,
        audio_streams: info
            .audio_streams
            .iter()
            .map(|audio| AudioStreamMetadata {
                sample_rate: audio.sample_rate,
                channels: audio.channels,
                codec: audio.codec.clone(),
            })
            .collect(),
    };
    Ok((reader, source, metadata))
}

pub fn probe_video(input: VideoInput<'_>, max_pixels: u64) -> Result<VideoMetadata, VideoError> {
    Ok(open(input, max_pixels)?.2)
}
pub fn probe_video_path(path_utf8: &[u8], max_pixels: u64) -> Result<VideoMetadata, VideoError> {
    let path = input_path(path_utf8)?;
    probe_video(VideoInput::Path(&path), max_pixels)
}

/// True when bytes 4..8 name an ISO base media box (`ftyp`) or a QuickTime top-level atom.
fn iso_box_tag(tag: &[u8]) -> bool {
    matches!(
        tag,
        b"ftyp" | b"moov" | b"mdat" | b"free" | b"skip" | b"wide" | b"pnot"
    )
}

fn is_iso_base_media(reader: &dyn filmcraft_media::ByteReader) -> bool {
    filmcraft_media::reader::read_range(reader, 4, 4)
        .map(|tag| iso_box_tag(&tag))
        .unwrap_or(false)
}

fn validated_mp4(reader: SharedReader) -> Result<Mp4File, VideoError> {
    check_container_budget(&*reader)?;
    let mp4 = filmcraft_isobmff::open(IsoReader(reader)).map_err(owner)?;
    let count = mp4
        .tracks
        .iter()
        .try_fold(0usize, |sum, track| sum.checked_add(track.samples.len()))
        .ok_or(VideoError::Invalid("sample count overflow"))?;
    if count > MAX_SAMPLES {
        return Err(VideoError::Invalid(
            "source exceeds one million indexed samples",
        ));
    }
    for track in &mp4.tracks {
        if track
            .samples
            .iter()
            .any(|sample| sample.size as usize > MAX_READ_BYTES)
        {
            return Err(VideoError::Invalid("source packet exceeds 32 MiB"));
        }
    }
    Ok(mp4)
}

// This checks allocation budgets only; parsing samples/configuration stays with FilmCraft.
fn check_container_budget(reader: &dyn filmcraft_media::ByteReader) -> Result<(), VideoError> {
    fn tables(bytes: &[u8], depth: usize, samples: &mut u64) -> Result<(), VideoError> {
        if depth > 16 {
            return Err(VideoError::Invalid("MP4 box nesting exceeds budget"));
        }
        let mut offset = 0;
        while bytes.len().saturating_sub(offset) >= 8 {
            let prefix = &bytes[offset..];
            let short = u32::from_be_bytes(
                prefix[..4]
                    .try_into()
                    .map_err(|_| VideoError::Invalid("truncated box"))?,
            ) as usize;
            let (size, header) = match short {
                0 => (prefix.len(), 8),
                1 if prefix.len() >= 16 => (
                    usize::try_from(u64::from_be_bytes(
                        prefix[8..16]
                            .try_into()
                            .map_err(|_| VideoError::Invalid("truncated large box"))?,
                    ))
                    .map_err(|_| VideoError::Invalid("large box overflow"))?,
                    16,
                ),
                1 => return Err(VideoError::Invalid("truncated large box")),
                value => (value, 8),
            };
            if size < header || size > prefix.len() {
                return Err(VideoError::Invalid("invalid MP4 header bounds"));
            }
            let body = &prefix[header..size];
            match &prefix[4..8] {
                b"trak" | b"mdia" | b"minf" | b"stbl" | b"traf" => {
                    tables(body, depth + 1, samples)?
                }
                b"stsz" | b"stz2" if body.len() >= 12 => {
                    *samples += u64::from(u32::from_be_bytes(
                        body[8..12]
                            .try_into()
                            .map_err(|_| VideoError::Invalid("truncated size table"))?,
                    ));
                }
                b"trun" if body.len() >= 8 => {
                    *samples += u64::from(u32::from_be_bytes(
                        body[4..8]
                            .try_into()
                            .map_err(|_| VideoError::Invalid("truncated fragment table"))?,
                    ));
                }
                _ => {}
            }
            if *samples > MAX_SAMPLES as u64 {
                return Err(VideoError::Invalid(
                    "MP4 declared sample count exceeds allocation budget",
                ));
            }
            offset += size;
        }
        Ok(())
    }
    let mut offset = 0u64;
    let mut headers = 0usize;
    let mut count = 0usize;
    let mut samples = 0u64;
    while reader.len().saturating_sub(offset) >= 8 {
        count += 1;
        if count > 10_000 {
            return Err(VideoError::Invalid(
                "MP4 top-level box count exceeds budget",
            ));
        }
        let mut prefix = [0u8; 16];
        reader.read_at(offset, &mut prefix[..8])?;
        let short = u32::from_be_bytes(
            prefix[..4]
                .try_into()
                .map_err(|_| VideoError::Invalid("truncated box"))?,
        );
        let (size, header) = match short {
            0 => (reader.len() - offset, 8),
            1 => {
                reader.read_at(offset + 8, &mut prefix[8..])?;
                (
                    u64::from_be_bytes(
                        prefix[8..]
                            .try_into()
                            .map_err(|_| VideoError::Invalid("truncated large box"))?,
                    ),
                    16,
                )
            }
            value => (u64::from(value), 8),
        };
        if size < header || size > reader.len() - offset {
            return Err(VideoError::Invalid("invalid MP4 top-level box bounds"));
        }
        if matches!(&prefix[4..8], b"moov" | b"moof") {
            let length = usize::try_from(size - header)
                .map_err(|_| VideoError::Invalid("MP4 header size overflow"))?;
            headers = headers
                .checked_add(length)
                .ok_or(VideoError::Invalid("MP4 header budget overflow"))?;
            if length > MAX_READ_BYTES || headers > MAX_CACHE_BYTES {
                return Err(VideoError::Invalid("MP4 header allocation budget exceeded"));
            }
            let mut bytes = vec![0u8; length];
            reader.read_at(offset + header, &mut bytes)?;
            tables(&bytes, 0, &mut samples)?;
        }
        offset += size;
    }
    Ok(())
}

/// One software decoder, its own bounded output cache, and lazy source audio.
/// Codec reference-picture buffers remain governed by FilmCraft's codec owners.
struct Mp4Session {
    reader: SharedReader,
    source: SharedSource,
    mp4: Mp4File,
    track: usize,
    decoder: Box<dyn VideoDecoder>,
    metadata: VideoMetadata,
    max_pixels: u64,
    cache: BTreeMap<i64, Arc<VideoFrame>>,
    cache_bytes: usize,
    decode_next: usize,
    presentation_order: Vec<usize>,
    presentation_next: usize,
    started: bool,
    cancel: Arc<AtomicBool>,
}

impl Mp4Session {
    fn from_parts(
        reader: SharedReader,
        source: SharedSource,
        metadata: VideoMetadata,
        max_pixels: u64,
    ) -> Result<Self, VideoError> {
        let mp4 = validated_mp4(Arc::clone(&reader))?;
        let track = mp4
            .tracks
            .iter()
            .position(|track| track.kind == TrackKind::Video && !track.samples.is_empty())
            .ok_or(VideoError::Invalid("MP4 has no video samples"))?;
        let video = &mp4.tracks[track];
        if video.timescale == 0
            || video.entries.len() != 1
            || video
                .samples
                .iter()
                .any(|sample| sample.description_index != 1)
        {
            return Err(VideoError::Invalid(
                "session requires one stable sample description and a valid clock",
            ));
        }
        if video.display_rotation() != Some(0)
            || video
                .video()
                .is_some_and(|params| params.clean_aperture.is_some())
        {
            return Err(VideoError::Invalid(
                "session does not support rotated or clean-aperture video",
            ));
        }
        let entry = video
            .entries
            .first()
            .ok_or(VideoError::Invalid("missing video sample description"))?;
        let decoder = filmcraft_media::cancel::with_background(true, || {
            filmcraft_codecs::software_video_decoder(entry)
        })
        .map_err(owner)?;
        let mut presentation_order: Vec<usize> = (0..video.samples.len()).collect();
        presentation_order.sort_by_key(|index| (video.samples[*index].pts, *index));
        Ok(Self {
            reader,
            source,
            mp4,
            track,
            decoder,
            metadata,
            max_pixels,
            cache: BTreeMap::new(),
            cache_bytes: 0,
            decode_next: 0,
            presentation_order,
            presentation_next: 0,
            started: false,
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    fn metadata(&self) -> &VideoMetadata {
        &self.metadata
    }
    fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
    fn cached_frames(&self) -> usize {
        self.cache.len()
    }
    fn cached_bytes(&self) -> usize {
        self.cache_bytes
    }

    fn retain(
        &mut self,
        decoded: Vec<filmcraft_codecs::video::DecodedFrame>,
        target: i64,
    ) -> Result<Option<Arc<VideoFrame>>, VideoError> {
        let mut selected = None;
        for mut decoded in decoded {
            if decoded.draft {
                return Err(VideoError::Invalid("owner returned an approximate frame"));
            }
            dimensions(decoded.frame.width, decoded.frame.height, self.max_pixels)?;
            if let Some(video) = self.source.info().video.as_ref() {
                decoded.frame.color = video.color;
            }
            let bytes = decoded.frame.byte_size();
            let frame = Arc::new(decoded.frame);
            if decoded.pts == target {
                selected = Some(Arc::clone(&frame));
            }
            if bytes <= MAX_CACHE_BYTES {
                if let Some(previous) = self.cache.insert(decoded.pts, frame) {
                    self.cache_bytes = self.cache_bytes.saturating_sub(previous.byte_size());
                }
                self.cache_bytes += bytes;
                while self.cache.len() > MAX_CACHE_FRAMES || self.cache_bytes > MAX_CACHE_BYTES {
                    if let Some((_, frame)) = self.cache.pop_first() {
                        self.cache_bytes = self.cache_bytes.saturating_sub(frame.byte_size());
                    }
                }
            }
        }
        Ok(selected)
    }

    fn decode_index(&mut self, index: usize) -> Result<DecodedRGBAFrame, VideoError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(VideoError::Cancelled);
        }
        let track = &self.mp4.tracks[self.track];
        let target = track
            .samples
            .get(index)
            .ok_or(VideoError::Invalid("frame index out of bounds"))?
            .pts;
        let time = Tick::from_units(
            target.saturating_add(track.edit_offset),
            i64::from(track.timescale),
        )
        .seconds();
        let mut frame = self.cache.get(&target).cloned();
        if frame.is_none() {
            if !self.started || self.decode_next > index {
                self.decoder.reset();
                self.cache.clear();
                self.cache_bytes = 0;
                self.decode_next = track.sync_sample_before(index);
                self.started = true;
            }
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut packets = 0;
            while frame.is_none() {
                if self.cancel.load(Ordering::Relaxed) {
                    return Err(VideoError::Cancelled);
                }
                if Instant::now() > deadline || packets >= 10_000 {
                    return Err(VideoError::Invalid(
                        "frame seek exceeded its packet or time budget",
                    ));
                }
                let flushing = self.decode_next >= self.mp4.tracks[self.track].samples.len();
                let decoded = if let Some(sample) = self.mp4.tracks[self.track]
                    .samples
                    .get(self.decode_next)
                    .copied()
                {
                    let bytes = self
                        .mp4
                        .read_sample(
                            &IsoReader(Arc::clone(&self.reader)),
                            self.track,
                            self.decode_next,
                        )
                        .map_err(owner)?;
                    self.decode_next += 1;
                    packets += 1;
                    filmcraft_media::cancel::with_cancel(&self.cancel, || {
                        filmcraft_media::cancel::with_background(true, || {
                            self.decoder.decode(&bytes, sample.pts)
                        })
                    })
                    .map_err(owner)?
                } else {
                    self.decoder.flush()
                };
                frame = self.retain(decoded, target)?;
                if frame.is_none() && flushing {
                    return Err(VideoError::Invalid(
                        "decoder did not produce the requested presentation frame",
                    ));
                }
            }
        }
        let frame = frame.ok_or(VideoError::Invalid("missing decoded frame"))?;
        let rgba = frame.to_rgba8();
        if rgba.len() as u64 != u64::from(frame.width) * u64::from(frame.height) * 4 {
            return Err(VideoError::Invalid("owner returned invalid RGBA length"));
        }
        Ok(DecodedRGBAFrame {
            width: frame.width,
            height: frame.height,
            timestamp_seconds: time,
            rgba,
        })
    }

    fn frame_rgba(&mut self, time_seconds: f64) -> Result<DecodedRGBAFrame, VideoError> {
        if !time_seconds.is_finite()
            || time_seconds < 0.0
            || self
                .metadata
                .duration_seconds
                .is_some_and(|duration| time_seconds >= duration)
        {
            return Err(VideoError::Invalid(
                "frame time must lie within the source duration",
            ));
        }
        let track = &self.mp4.tracks[self.track];
        let time = Tick::from_seconds_f64(time_seconds).to_units_floor(i64::from(track.timescale));
        let index = track
            .sample_at_presentation_time(time)
            .ok_or(VideoError::Invalid("source has no frame at this time"))?;
        self.presentation_next = self
            .presentation_order
            .iter()
            .position(|candidate| *candidate == index)
            .ok_or(VideoError::Invalid("missing presentation index"))?
            + 1;
        self.decode_index(index)
    }

    fn next_frame(&mut self) -> Result<Option<DecodedRGBAFrame>, VideoError> {
        let Some(index) = self.presentation_order.get(self.presentation_next).copied() else {
            return Ok(None);
        };
        self.presentation_next += 1;
        self.decode_index(index).map(Some)
    }

    fn audio_stream(
        &self,
        stream: usize,
        start: i64,
        frames: usize,
        sample_rate: u32,
    ) -> Result<filmcraft_frame::AudioBuffer, VideoError> {
        let audio = self
            .metadata
            .audio_streams
            .get(stream)
            .ok_or(VideoError::Invalid("audio stream index out of bounds"))?;
        audio_window(audio.channels, start, frames, sample_rate)?;
        filmcraft_media::cancel::with_cancel(&self.cancel, || {
            self.source.audio_stream(stream, start, frames, sample_rate)
        })
        .map_err(owner)
    }
}

fn audio_window(
    channels: u32,
    start: i64,
    frames: usize,
    sample_rate: u32,
) -> Result<(), VideoError> {
    if start < 0
        || sample_rate == 0
        || sample_rate > 192_000
        || frames as u64 > u64::from(sample_rate) * 30
        || (frames as u64)
            .saturating_mul(u64::from(channels))
            .saturating_mul(4)
            > MAX_CACHE_BYTES as u64
    {
        return Err(VideoError::Invalid(
            "audio request exceeds its window budget",
        ));
    }
    Ok(())
}

/// Decoder for containers other than ISO base media (WebM, Matroska, AVI, MPEG-TS, ...):
/// FilmCraft's container owner seeks and decodes through `MediaSource::video_frame`.
struct GenericSession {
    source: SharedSource,
    metadata: VideoMetadata,
    max_pixels: u64,
    next_index: u64,
    cancel: Arc<AtomicBool>,
}

impl GenericSession {
    fn rate(&self) -> f64 {
        self.metadata.fps_numerator as f64 / self.metadata.fps_denominator as f64
    }

    fn decode_at(&mut self, index: u64) -> Result<DecodedRGBAFrame, VideoError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(VideoError::Cancelled);
        }
        let timestamp = index as f64 / self.rate();
        let request = filmcraft_media::FrameRequest::full(Tick::from_seconds_f64(timestamp));
        let frame = filmcraft_media::cancel::with_cancel(&self.cancel, || {
            filmcraft_media::cancel::with_background(true, || self.source.video_frame(request))
        })
        .map_err(owner)?;
        dimensions(frame.width, frame.height, self.max_pixels)?;
        let rgba = frame.to_rgba8();
        if rgba.len() as u64 != u64::from(frame.width) * u64::from(frame.height) * 4 {
            return Err(VideoError::Invalid("owner returned invalid RGBA length"));
        }
        Ok(DecodedRGBAFrame {
            width: frame.width,
            height: frame.height,
            timestamp_seconds: timestamp,
            rgba,
        })
    }

    fn frame_rgba(&mut self, time_seconds: f64) -> Result<DecodedRGBAFrame, VideoError> {
        if !time_seconds.is_finite()
            || time_seconds < 0.0
            || self
                .metadata
                .duration_seconds
                .is_some_and(|duration| time_seconds >= duration)
        {
            return Err(VideoError::Invalid(
                "frame time must lie within the source duration",
            ));
        }
        let index = (time_seconds * self.rate()).floor() as u64;
        self.next_index = index.saturating_add(1);
        self.decode_at(index)
    }

    fn next_frame(&mut self) -> Result<Option<DecodedRGBAFrame>, VideoError> {
        if self.next_index >= self.metadata.frame_count {
            return Ok(None);
        }
        let index = self.next_index;
        self.next_index += 1;
        self.decode_at(index).map(Some)
    }
}

enum Backend {
    Iso(Box<Mp4Session>),
    Generic(GenericSession),
}

/// A bounded decoded-frame session over any container FilmCraft opens.
pub struct VideoSession {
    backend: Backend,
}

impl VideoSession {
    pub fn open_path(path_utf8: &[u8], max_pixels: u64) -> Result<Self, VideoError> {
        let path = input_path(path_utf8)?;
        Self::open(VideoInput::Path(&path), max_pixels)
    }
    pub fn open(input: VideoInput<'_>, max_pixels: u64) -> Result<Self, VideoError> {
        let (reader, source, metadata) = open(input, max_pixels)?;
        let backend = if is_iso_base_media(&*reader) {
            Backend::Iso(Box::new(Mp4Session::from_parts(
                reader, source, metadata, max_pixels,
            )?))
        } else {
            Backend::Generic(GenericSession {
                source,
                metadata,
                max_pixels,
                next_index: 0,
                cancel: Arc::new(AtomicBool::new(false)),
            })
        };
        Ok(Self { backend })
    }
    pub fn metadata(&self) -> &VideoMetadata {
        match &self.backend {
            Backend::Iso(session) => session.metadata(),
            Backend::Generic(session) => &session.metadata,
        }
    }
    pub fn cancel(&self) {
        match &self.backend {
            Backend::Iso(session) => session.cancel(),
            Backend::Generic(session) => session.cancel.store(true, Ordering::Relaxed),
        }
    }
    fn set_cancel(&mut self, cancel: Arc<AtomicBool>) {
        match &mut self.backend {
            Backend::Iso(session) => session.cancel = cancel,
            Backend::Generic(session) => session.cancel = cancel,
        }
    }
    pub fn cached_frames(&self) -> usize {
        match &self.backend {
            Backend::Iso(session) => session.cached_frames(),
            Backend::Generic(_) => 0,
        }
    }
    pub fn cached_bytes(&self) -> usize {
        match &self.backend {
            Backend::Iso(session) => session.cached_bytes(),
            Backend::Generic(_) => 0,
        }
    }
    pub fn frame_rgba(&mut self, time_seconds: f64) -> Result<DecodedRGBAFrame, VideoError> {
        match &mut self.backend {
            Backend::Iso(session) => session.frame_rgba(time_seconds),
            Backend::Generic(session) => session.frame_rgba(time_seconds),
        }
    }
    pub fn frame(&mut self, time_seconds: f64) -> Result<DecodedVideoFrame, VideoError> {
        let frame = self.frame_rgba(time_seconds)?;
        Ok(DecodedVideoFrame {
            width: frame.width,
            height: frame.height,
            timestamp_seconds: Some(frame.timestamp_seconds),
            png: crate::encode_rgba_png(frame.width, frame.height, &frame.rgba)?,
        })
    }
    pub fn next_frame(&mut self) -> Result<Option<DecodedRGBAFrame>, VideoError> {
        match &mut self.backend {
            Backend::Iso(session) => session.next_frame(),
            Backend::Generic(session) => session.next_frame(),
        }
    }
    pub fn audio_stream(
        &self,
        stream: usize,
        start: i64,
        frames: usize,
        sample_rate: u32,
    ) -> Result<filmcraft_frame::AudioBuffer, VideoError> {
        match &self.backend {
            Backend::Iso(session) => session.audio_stream(stream, start, frames, sample_rate),
            Backend::Generic(session) => {
                let audio = session
                    .metadata
                    .audio_streams
                    .get(stream)
                    .ok_or(VideoError::Invalid("audio stream index out of bounds"))?;
                audio_window(audio.channels, start, frames, sample_rate)?;
                filmcraft_media::cancel::with_cancel(&session.cancel, || {
                    session
                        .source
                        .audio_stream(stream, start, frames, sample_rate)
                })
                .map_err(owner)
            }
        }
    }
}

pub fn decode_video_frame(
    input: VideoInput<'_>,
    time_seconds: f64,
    max_pixels: u64,
) -> Result<DecodedVideoFrame, VideoError> {
    VideoSession::open(input, max_pixels)?.frame(time_seconds)
}
pub fn decode_video_frame_path(
    path_utf8: &[u8],
    time_seconds: f64,
    max_pixels: u64,
) -> Result<DecodedVideoFrame, VideoError> {
    let path = input_path(path_utf8)?;
    decode_video_frame(VideoInput::Path(&path), time_seconds, max_pixels)
}

pub fn decode_video_frame_with_cancel(
    input: VideoInput<'_>,
    time_seconds: f64,
    max_pixels: u64,
    cancel: VideoCancel,
) -> Result<DecodedVideoFrame, VideoError> {
    let mut session = VideoSession::open(input, max_pixels)?;
    if let Some(cancel) = cancel {
        session.set_cancel(cancel);
    }
    session.frame(time_seconds)
}

pub fn decode_video_frame_path_with_cancel(
    path_utf8: &[u8],
    time_seconds: f64,
    max_pixels: u64,
    cancel: VideoCancel,
) -> Result<DecodedVideoFrame, VideoError> {
    let path = input_path(path_utf8)?;
    decode_video_frame_with_cancel(VideoInput::Path(&path), time_seconds, max_pixels, cancel)
}

/// Copies every represented audio/video sample byte without invoking an encoder.
/// Unsupported timing/track metadata is refused before creating the output file.
pub fn remux_mp4(input: VideoInput<'_>, output: &Path) -> Result<u64, VideoError> {
    if !output.is_absolute() {
        return Err(VideoError::Invalid("remux output path must be absolute"));
    }
    let reader = reader(input)?;
    let source = validated_mp4(Arc::clone(&reader))?;
    if source.timescale == 0 || source.tracks.is_empty() {
        return Err(VideoError::Invalid("invalid MP4 movie clock"));
    }
    for track in &source.tracks {
        if !matches!(track.kind, TrackKind::Audio | TrackKind::Video)
            || track.timescale == 0
            || track.entries.len() != 1
            || !track.references.is_empty()
            || !track.sample_groups.is_empty()
            || !track.sdtp.is_empty()
            || track
                .display_rotation()
                .is_some_and(|rotation| rotation != 0)
        {
            return Err(VideoError::Invalid(
                "remux cannot preserve this track configuration",
            ));
        }
        let mut dts = 0i64;
        for sample in &track.samples {
            if sample.description_index != 1
                || sample.dts != dts
                || i32::try_from(sample.pts.saturating_sub(sample.dts)).is_err()
            {
                return Err(VideoError::Invalid(
                    "remux cannot preserve this sample timing",
                ));
            }
            dts = dts
                .checked_add(i64::from(sample.duration))
                .ok_or(VideoError::Invalid("sample clock overflow"))?;
        }
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(output)?;
    let result = (|| {
        let mut options = filmcraft_isobmff::WriterOptions::new(filmcraft_isobmff::Brand::Mp4);
        options.movie_timescale = source.timescale;
        options.metadata.clone_from(&source.metadata.entries);
        let mut writer = Mp4Writer::new(file, options).map_err(owner)?;
        for track in &source.tracks {
            let entry = track
                .entries
                .first()
                .ok_or(VideoError::Invalid("missing track description"))?
                .clone();
            let mut config = filmcraft_isobmff::TrackConfig::new(entry, track.timescale);
            config.language.clone_from(&track.language);
            config.edits.clone_from(&track.edits);
            config.handler_name = Some(track.handler_name.clone());
            writer.add_track(config).map_err(owner)?;
        }
        for (track_index, track) in source.tracks.iter().enumerate() {
            for (index, sample) in track.samples.iter().enumerate() {
                let data = source
                    .read_sample(&IsoReader(Arc::clone(&reader)), track_index, index)
                    .map_err(owner)?;
                writer
                    .write_sample(
                        track_index,
                        WriteSample {
                            data: &data,
                            duration: sample.duration,
                            composition_offset: i32::try_from(sample.pts - sample.dts)
                                .map_err(|_| VideoError::Invalid("composition offset overflow"))?,
                            is_sync: sample.is_sync,
                        },
                    )
                    .map_err(owner)?;
            }
        }
        let file = writer.finish().map_err(owner)?;
        file.sync_all()?;
        Ok(file.metadata()?.len())
    })();
    if result.is_err() {
        std::fs::remove_file(output)?;
    }
    result
}

fn output_path(path_utf8: &[u8]) -> Result<std::path::PathBuf, VideoError> {
    let text = std::str::from_utf8(path_utf8)
        .map_err(|_| VideoError::Invalid("output path must be UTF-8"))?;
    let path = Path::new(text);
    if path.is_absolute() {
        Ok(path.into())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}
const REMUX_DEADLINE: Duration = Duration::from_secs(600);

fn output_container(output: &Path) -> Result<filmcraft_lib::OutputContainer, VideoError> {
    output
        .extension()
        .and_then(|extension| extension.to_str())
        .and_then(filmcraft_lib::OutputContainer::from_extension)
        .ok_or(VideoError::Invalid(
            "remux output must end in .mp4, .m4v, .mov, .mkv or .webm",
        ))
}

fn starts_iso_base_media(input: &VideoInput<'_>) -> Result<bool, VideoError> {
    let mut head = [0u8; 8];
    match input {
        VideoInput::Bytes(bytes) => {
            let Some(prefix) = bytes.get(..8) else {
                return Ok(false);
            };
            head.copy_from_slice(prefix);
        }
        VideoInput::Path(path) => {
            use std::io::Read;
            if std::fs::File::open(path)?.read_exact(&mut head).is_err() {
                return Ok(false);
            }
        }
    }
    Ok(iso_box_tag(&head[4..8]))
}

/// Copies compressed packets between MP4, QuickTime, Matroska and WebM without re-encoding.
fn remux_container(
    input: VideoInput<'_>,
    output: &Path,
    container: filmcraft_lib::OutputContainer,
) -> Result<u64, VideoError> {
    let demuxer = open_demuxer(input)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(output)?;
    let result = (|| {
        let options = filmcraft_lib::RemuxOptions::new(container);
        let control = filmcraft_lib::Control::new().with_timeout(REMUX_DEADLINE);
        let (file, report) =
            filmcraft_lib::remux(&demuxer, file, &options, &control).map_err(owner)?;
        if report.copied.is_empty() {
            return Err(VideoError::Invalid(
                "no audio or video track can be remuxed",
            ));
        }
        file.sync_all()?;
        Ok(file.metadata()?.len())
    })();
    if result.is_err() {
        std::fs::remove_file(output)?;
    }
    result
}

/// The output extension selects the container. MP4 sources written to an MP4 keep the strict,
/// byte-exact sample-table path; every other pair goes through the FilmCraft library remuxer.
pub fn remux(input: VideoInput<'_>, output: &Path) -> Result<u64, VideoError> {
    if !output.is_absolute() {
        return Err(VideoError::Invalid("remux output path must be absolute"));
    }
    let container = output_container(output)?;
    if container == filmcraft_lib::OutputContainer::Mp4 && starts_iso_base_media(&input)? {
        return remux_mp4(input, output);
    }
    remux_container(input, output, container)
}
pub fn remux_path(input_utf8: &[u8], output_utf8: &[u8]) -> Result<u64, VideoError> {
    let input = input_path(input_utf8)?;
    remux(VideoInput::Path(&input), &output_path(output_utf8)?)
}
pub fn remux_bytes(input: Arc<[u8]>, output_utf8: &[u8]) -> Result<u64, VideoError> {
    remux(VideoInput::Bytes(input), &output_path(output_utf8)?)
}
const HLS_DEADLINE: Duration = Duration::from_secs(1800);
const HLS_MAX_SEGMENTS: usize = 100_000;

fn open_demuxer(input: VideoInput<'_>) -> Result<Demuxer, VideoError> {
    let limits = demux_limits();
    match input {
        VideoInput::Path(path) => {
            let metadata = std::fs::metadata(path)?;
            if !metadata.is_file() || metadata.len() == 0 {
                return Err(VideoError::Invalid(
                    "video input must be a regular nonempty file",
                ));
            }
            Demuxer::open_path(path, &limits).map_err(owner)
        }
        VideoInput::Bytes(bytes) => {
            if <[u8]>::is_empty(&bytes) || <[u8]>::len(&bytes) > MAX_MEMORY_BYTES {
                return Err(VideoError::Invalid(
                    "in-memory video must be nonempty and at most 256 MiB",
                ));
            }
            Demuxer::open_bytes(bytes, &limits).map_err(owner)
        }
    }
}

/// Cuts an MP4, QuickTime, Matroska or WebM source into CMAF segments without re-encoding and writes
/// `init.mp4`, `segment-NNNNN.m4s` and a VOD `playlist.m3u8` into a directory that must not exist.
/// Segments are written as they are produced, so memory stays bounded by one segment.
pub fn package_hls(
    input: VideoInput<'_>,
    directory: &Path,
    target_ms: u32,
) -> Result<u64, VideoError> {
    use filmcraft_lib::{SegmentEvent, SegmentOptions};
    use std::fmt::Write as _;
    if !directory.is_absolute() {
        return Err(VideoError::Invalid("HLS output directory must be absolute"));
    }
    if !(500..=60_000).contains(&target_ms) {
        return Err(VideoError::Invalid(
            "HLS segment length must be between 0.5 and 60 seconds",
        ));
    }
    let demuxer = open_demuxer(input)?;
    std::fs::create_dir(directory)?;
    let result = (|| {
        let mut options = SegmentOptions::new();
        options.target_ms = target_ms;
        options.limits = demux_limits();
        let control = filmcraft_lib::Control::new().with_timeout(HLS_DEADLINE);
        let mut durations: Vec<f64> = Vec::new();
        filmcraft_lib::segment_with(&demuxer, &options, &control, |event| {
            match event {
                SegmentEvent::Init(bytes) => std::fs::write(directory.join("init.mp4"), bytes)?,
                SegmentEvent::Segment(segment) => {
                    if durations.len() >= HLS_MAX_SEGMENTS {
                        return Err(filmcraft_lib::Error::new(
                            filmcraft_lib::ErrorKind::LimitExceeded,
                            "HLS output exceeds 100000 segments",
                        ));
                    }
                    std::fs::write(
                        directory.join(format!("segment-{:05}.m4s", segment.index)),
                        &segment.data,
                    )?;
                    durations.push(segment.duration.seconds());
                }
                _ => {}
            }
            Ok(())
        })
        .map_err(owner)?;
        if durations.is_empty() {
            return Err(VideoError::Invalid(
                "no audio or video track can be segmented",
            ));
        }
        let target = durations
            .iter()
            .map(|seconds| seconds.ceil() as u64)
            .max()
            .unwrap_or(1)
            .max(1);
        let mut playlist = format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"init.mp4\"\n"
        );
        for (index, seconds) in durations.iter().enumerate() {
            let _ = write!(playlist, "#EXTINF:{seconds:.6},\nsegment-{index:05}.m4s\n");
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        std::fs::write(directory.join("playlist.m3u8"), playlist)?;
        Ok(durations.len() as u64)
    })();
    if result.is_err() {
        std::fs::remove_dir_all(directory)?;
    }
    result
}
pub fn package_hls_path(
    input_utf8: &[u8],
    directory_utf8: &[u8],
    target_ms: u32,
) -> Result<u64, VideoError> {
    let input = input_path(input_utf8)?;
    package_hls(
        VideoInput::Path(&input),
        &output_path(directory_utf8)?,
        target_ms,
    )
}
pub fn package_hls_bytes(
    input: Arc<[u8]>,
    directory_utf8: &[u8],
    target_ms: u32,
) -> Result<u64, VideoError> {
    package_hls(
        VideoInput::Bytes(input),
        &output_path(directory_utf8)?,
        target_ms,
    )
}

pub fn remux_mp4_path(input_utf8: &[u8], output_utf8: &[u8]) -> Result<u64, VideoError> {
    let input = input_path(input_utf8)?;
    remux_mp4(VideoInput::Path(&input), &output_path(output_utf8)?)
}
pub fn remux_mp4_bytes(input: Arc<[u8]>, output_utf8: &[u8]) -> Result<u64, VideoError> {
    remux_mp4(VideoInput::Bytes(input), &output_path(output_utf8)?)
}

fn validate_window(
    metadata: &VideoMetadata,
    start: f64,
    duration: f64,
    maximum: f64,
) -> Result<(), VideoError> {
    if !start.is_finite()
        || !duration.is_finite()
        || start < 0.0
        || duration <= 0.0
        || duration > maximum
        || metadata
            .duration_seconds
            .is_some_and(|end| start + duration > end + 0.001)
    {
        return Err(VideoError::Invalid(
            "media window exceeds source duration or operation budget",
        ));
    }
    Ok(())
}

/// A bounded signed-16-bit PCM WAV window; this is not the original compressed audio bitstream.
pub fn encode_audio_wav(
    input: VideoInput<'_>,
    start_seconds: f64,
    duration_seconds: f64,
    stream: usize,
    sample_rate: u32,
    max_pixels: u64,
) -> Result<Vec<u8>, VideoError> {
    let (reader, source, metadata) = open(input, max_pixels)?;
    drop(reader);
    validate_window(&metadata, start_seconds, duration_seconds, 30.0)?;
    let audio = metadata
        .audio_streams
        .get(stream)
        .ok_or(VideoError::Invalid("audio stream index out of bounds"))?;
    if sample_rate == 0 || sample_rate > 192_000 || audio.channels == 0 || audio.channels > 64 {
        return Err(VideoError::Invalid("invalid audio sample rate or channels"));
    }
    let frames = (duration_seconds * f64::from(sample_rate)).ceil() as usize;
    let samples = frames
        .checked_mul(audio.channels as usize)
        .ok_or(VideoError::Invalid("audio sample count overflow"))?;
    if samples > MAX_CACHE_BYTES / 4 {
        return Err(VideoError::Invalid(
            "audio window exceeds 64 MiB planar budget",
        ));
    }
    let start = (start_seconds * f64::from(sample_rate)).floor() as i64;
    let buffer = source
        .audio_stream(stream, start, frames, sample_rate)
        .map_err(owner)?;
    if buffer.channel_count() != audio.channels as usize
        || buffer.frames() != frames
        || buffer
            .channels
            .iter()
            .any(|channel| channel.len() != frames)
    {
        return Err(VideoError::Invalid(
            "owner returned an invalid audio window",
        ));
    }
    let data_bytes =
        u32::try_from(samples * 2).map_err(|_| VideoError::Invalid("WAV length overflow"))?;
    let channels = audio.channels as u16;
    let block = channels * 2;
    let mut output = Vec::with_capacity(data_bytes as usize + 44);
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&(data_bytes + 36).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16u32.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&channels.to_le_bytes());
    output.extend_from_slice(&sample_rate.to_le_bytes());
    output.extend_from_slice(&(sample_rate * u32::from(block)).to_le_bytes());
    output.extend_from_slice(&block.to_le_bytes());
    output.extend_from_slice(&16u16.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&data_bytes.to_le_bytes());
    for frame in 0..frames {
        for channel in &buffer.channels {
            let sample = channel[frame];
            if !sample.is_finite() {
                return Err(VideoError::Invalid(
                    "owner returned a non-finite audio sample",
                ));
            }
            let sample = (sample.clamp(-1.0, 1.0) * if sample < 0.0 { 32768.0 } else { 32767.0 })
                .round() as i16;
            output.extend_from_slice(&sample.to_le_bytes());
        }
    }
    Ok(output)
}
pub fn encode_audio_wav_path(
    path_utf8: &[u8],
    start_seconds: f64,
    duration_seconds: f64,
    stream: usize,
    sample_rate: u32,
    max_pixels: u64,
) -> Result<Vec<u8>, VideoError> {
    let path = input_path(path_utf8)?;
    encode_audio_wav(
        VideoInput::Path(&path),
        start_seconds,
        duration_seconds,
        stream,
        sample_rate,
        max_pixels,
    )
}

struct GifOutput(Vec<u8>);
impl io::Write for GifOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > 32 * 1024 * 1024 {
            return Err(io::Error::other("GIF output exceeds 32 MiB"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// GIF is palette-quantized with binary transparency and centisecond timing, hence lossy.
pub fn encode_gif(
    input: VideoInput<'_>,
    start_seconds: f64,
    duration_seconds: f64,
    fps: u16,
    width: u16,
    max_pixels: u64,
) -> Result<Vec<u8>, VideoError> {
    if fps == 0 || fps > 24 || width == 0 || width > 640 {
        return Err(VideoError::Invalid(
            "GIF requires fps 1..24 and width 1..640",
        ));
    }
    let mut session = VideoSession::open(input, max_pixels)?;
    validate_window(session.metadata(), start_seconds, duration_seconds, 5.0)?;
    let frame_count = (duration_seconds * f64::from(fps)).ceil() as usize;
    if frame_count > 120 {
        return Err(VideoError::Invalid("GIF exceeds 120 frames"));
    }
    let factor = session
        .metadata()
        .width
        .div_ceil(u32::from(width))
        .max(session.metadata().height.div_ceil(360))
        .max(1);
    let output_width = (session.metadata().width / factor).max(1) as u16;
    let output_height = (session.metadata().height / factor).max(1) as u16;
    let mut output = GifOutput(Vec::new());
    {
        let mut encoder =
            gif::Encoder::new(&mut output, output_width, output_height, &[]).map_err(owner)?;
        encoder.set_repeat(gif::Repeat::Infinite).map_err(owner)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        for index in 0..frame_count {
            if Instant::now() > deadline {
                return Err(VideoError::Invalid("GIF exceeded its two-minute budget"));
            }
            let frame = session.frame_rgba(start_seconds + index as f64 / f64::from(fps))?;
            let owned = VideoFrame::rgba8(frame.width, frame.height, frame.rgba);
            let scaled = if factor == 1 {
                owned
            } else {
                let (width, height, linear) = owned.to_linear_f32_decimated(factor as usize);
                VideoFrame::rgba_f32(width as u32, height as u32, linear)
            };
            if scaled.width != u32::from(output_width) || scaled.height != u32::from(output_height)
            {
                return Err(VideoError::Invalid("GIF frame dimensions changed"));
            }
            let mut pixels = scaled.to_rgba8();
            let mut frame =
                gif::Frame::from_rgba_speed(output_width, output_height, &mut pixels, 10);
            let start = ((index as f64 / f64::from(fps)) * 100.0).round() as u16;
            let end = (((index + 1) as f64 / f64::from(fps)).min(duration_seconds) * 100.0).round()
                as u16;
            frame.delay = end.saturating_sub(start).max(1);
            frame.dispose = gif::DisposalMethod::Background;
            encoder.write_frame(&frame).map_err(owner)?;
        }
    }
    Ok(output.0)
}
pub fn encode_gif_path(
    path_utf8: &[u8],
    start_seconds: f64,
    duration_seconds: f64,
    fps: u16,
    width: u16,
    max_pixels: u64,
) -> Result<Vec<u8>, VideoError> {
    let path = input_path(path_utf8)?;
    encode_gif(
        VideoInput::Path(&path),
        start_seconds,
        duration_seconds,
        fps,
        width,
        max_pixels,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use filmcraft_isobmff::{AvcConfig, Brand, SampleEntry, TrackConfig, WriterOptions};
    use std::io::Cursor;

    #[cfg(feature = "filmcraft-encode")]
    fn pcm_encoder(output_limit: usize) -> VideoEncoderSession {
        let mut audio = filmcraft_lib::AudioOptions::aac(48_000, 1);
        audio.codec = filmcraft_lib::AudioCodec::Pcm16;
        let mut options = filmcraft_lib::EncoderOptions::new(None, Some(audio));
        options.quicktime = true;
        VideoEncoderSession::new(options, 4096, output_limit, None).unwrap()
    }

    #[test]
    #[cfg(feature = "filmcraft-encode")]
    fn native_encoder_writes_known_pcm_samples_and_exact_timing() {
        let mut encoder = pcm_encoder(4096);
        encoder
            .push_audio(&[vec![-1.0, -0.5, 0.0, 0.5, 1.0]])
            .unwrap();
        let (bytes, report) = encoder.finish().unwrap();
        assert_eq!(report.audio_samples, 5);
        assert_eq!(report.video_frames, 0);
        let movie = filmcraft_isobmff::open(bytes.as_slice()).unwrap();
        assert_eq!(movie.tracks.len(), 1);
        let track = &movie.tracks[0];
        assert_eq!(track.timescale, 48_000);
        assert_eq!(
            track
                .samples
                .iter()
                .map(|sample| u64::from(sample.duration))
                .sum::<u64>(),
            5
        );
        // Independent signed PCM16 little-endian values; no encoder/decoder roundtrip oracle.
        let expected = [-32767i16, -16384, 0, 16384, 32767]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(movie.read_sample(bytes.as_slice(), 0, 0).unwrap(), expected);
    }

    #[test]
    #[cfg(feature = "filmcraft-encode")]
    fn native_encoder_enforces_input_output_cancellation_and_error_state() {
        let mut encoder = pcm_encoder(4096);
        assert!(encoder.push_audio(&[vec![0.0; 1025]]).is_err());
        assert!(encoder.push_audio(&[vec![f32::NAN]]).is_err());
        assert!(encoder.push_audio(&[vec![2.0]]).is_err());
        encoder.push_audio(&[vec![0.0; 1024]]).unwrap();
        assert!(encoder.push_audio(&[vec![0.0]]).is_err());
        assert_eq!(encoder.finish().unwrap().1.audio_samples, 1024);

        let mut small = pcm_encoder(8);
        assert!(small.push_audio(&[vec![0.0; 16]]).is_err());
        assert!(matches!(
            small.finish(),
            Err(VideoError::Invalid(
                "video encoder is closed after an error"
            ))
        ));

        let mut cancelled = pcm_encoder(4096);
        cancelled.cancel();
        assert!(matches!(
            cancelled.push_audio(&[vec![0.0]]),
            Err(VideoError::Cancelled)
        ));
        assert!(matches!(cancelled.finish(), Err(VideoError::Cancelled)));
    }

    #[test]
    #[cfg(feature = "filmcraft-encode")]
    fn native_h264_encoding_preserves_rational_frame_timing_and_black_content() {
        let video = filmcraft_lib::VideoOptions::new(
            filmcraft_lib::VideoCodec::H264,
            64,
            48,
            filmcraft_lib::FrameRate {
                num: 30_000,
                den: 1001,
            },
        );
        let options = filmcraft_lib::EncoderOptions::new(Some(video), None);
        let mut encoder =
            VideoEncoderSession::new(options, 64 * 48 * 4 * 3, 1024 * 1024, None).unwrap();
        let pixels = [0, 0, 0, 255].repeat(64 * 48);
        for _ in 0..3 {
            encoder.push_rgba(&pixels).unwrap();
        }
        let (bytes, report) = encoder.finish().unwrap();
        assert_eq!(report.video_frames, 3);
        let movie = filmcraft_isobmff::open(bytes.as_slice()).unwrap();
        assert_eq!(movie.tracks[0].timescale, 30_000);
        assert_eq!(movie.tracks[0].samples.len(), 3);
        assert!(
            movie.tracks[0]
                .samples
                .iter()
                .all(|sample| sample.duration == 1001)
        );
        let mut decoded = VideoSession::open(VideoInput::Bytes(bytes.into()), 64 * 48).unwrap();
        let frame = decoded.next_frame().unwrap().unwrap();
        assert_eq!((frame.width, frame.height), (64, 48));
        assert!(
            frame
                .rgba
                .chunks_exact(4)
                .all(|pixel| pixel[0] <= 3 && pixel[1] <= 3 && pixel[2] <= 3 && pixel[3] == 255)
        );
    }

    #[test]
    #[cfg(feature = "filmcraft-encode")]
    fn native_rgba_stream_export_checks_the_declared_frames_before_creating_output() {
        let root = remux_scratch("encode-stream");
        let output = root.join("stream.mp4");
        let fps = filmcraft_lib::FrameRate { num: 24_000, den: 1001 };
        let pixels = [0, 0, 0, 255].repeat(64 * 48 * 3);
        assert!(encode_rgba_stream(&mut &pixels[..pixels.len() - 1], &output, 64, 48, fps, 3).is_err());
        assert!(!output.exists());
        assert!(encode_rgba_stream(&mut &pixels[..], &output, 64, 48, fps, 2).is_err());
        assert!(!output.exists());
        let bytes = encode_rgba_stream(&mut &pixels[..], &output, 64, 48, fps, 3).unwrap();
        assert_eq!(bytes, std::fs::metadata(&output).unwrap().len());
        let movie = filmcraft_isobmff::open(std::fs::read(&output).unwrap().as_slice()).unwrap();
        assert_eq!(movie.tracks[0].samples.len(), 3);
        assert_eq!(movie.tracks[0].timescale, 24_000);
        assert!(movie.tracks[0].samples.iter().all(|sample| sample.duration == 1001));
        assert!(encode_rgba_stream(&mut &pixels[..], &output, 64, 48, fps, 3).is_err());
        assert_eq!(std::fs::metadata(&output).unwrap().len(), bytes);
        std::fs::remove_file(output).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn budgets_and_paths_are_rejected_before_decoding() {
        assert!(matches!(
            probe_video(VideoInput::Bytes(Arc::from([])), 4096),
            Err(VideoError::Invalid(_))
        ));
        assert!(probe_video_path(&[0xff], 4096).is_err());
        assert!(probe_video_path(b"relative.mp4", 4096).is_err());
        assert!(dimensions(1920, 1080, 1920 * 1080 - 1).is_err());
        assert!(dimensions(1920, 1080, 1920 * 1080).is_ok());
        assert!(dimensions(0, 1080, 1920 * 1080).is_err());
    }

    fn remux_scratch(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("bun-video-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn packet_counts(path: &Path) -> Vec<(String, u64)> {
        let demuxer =
            filmcraft_lib::Demuxer::open_path(path, &filmcraft_lib::Limits::default()).unwrap();
        demuxer
            .tracks()
            .iter()
            .map(|track| (track.codec.clone(), track.packets))
            .collect()
    }

    #[test]
    fn remux_converts_between_mp4_and_matroska_keeping_every_packet() {
        let source = filmcraft_lib::doc_fixtures::mp4_h264_aac();
        let root = remux_scratch("remux-convert");
        let source_path = root.join("source.mp4");
        std::fs::write(&source_path, &source).unwrap();
        let expected = packet_counts(&source_path);
        assert_eq!(expected.len(), 2);

        let mkv = root.join("copy.mkv");
        let written = remux_bytes(source.into(), mkv.to_str().unwrap().as_bytes()).unwrap();
        let bytes = std::fs::read(&mkv).unwrap();
        assert_eq!(written, bytes.len() as u64);
        assert_eq!(&bytes[..4], &[0x1a, 0x45, 0xdf, 0xa3]);
        assert_eq!(packet_counts(&mkv), expected);

        let back = root.join("back.mp4");
        remux_path(
            mkv.to_str().unwrap().as_bytes(),
            back.to_str().unwrap().as_bytes(),
        )
        .unwrap();
        assert_eq!(packet_counts(&back), expected);

        let quicktime = root.join("copy.mov");
        remux_path(
            mkv.to_str().unwrap().as_bytes(),
            quicktime.to_str().unwrap().as_bytes(),
        )
        .unwrap();
        assert_eq!(packet_counts(&quicktime), expected);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remux_refuses_bad_targets_and_never_leaves_partial_output() {
        let source: Arc<[u8]> = filmcraft_lib::doc_fixtures::mp4_h264_aac().into();
        let root = remux_scratch("remux-refuse");
        let target = |name: &str| root.join(name).to_str().unwrap().as_bytes().to_vec();

        assert!(matches!(
            remux(
                VideoInput::Bytes(Arc::clone(&source)),
                Path::new("relative.mkv")
            ),
            Err(VideoError::Invalid("remux output path must be absolute"))
        ));
        assert!(matches!(
            remux_bytes(Arc::clone(&source), &target("clip.avi")),
            Err(VideoError::Invalid(message)) if message.contains(".webm")
        ));
        assert!(!root.join("clip.avi").exists());

        // WebM carries VP8/VP9/AV1 and Opus/Vorbis only: H.264 and AAC have no mapping.
        assert!(remux_bytes(Arc::clone(&source), &target("clip.webm")).is_err());
        assert!(!root.join("clip.webm").exists());

        let first = target("first.mkv");
        remux_bytes(Arc::clone(&source), &first).unwrap();
        let before = std::fs::read(root.join("first.mkv")).unwrap();
        assert!(remux_bytes(source, &first).is_err());
        assert_eq!(std::fs::read(root.join("first.mkv")).unwrap(), before);

        // Not a supported container for the library remuxer.
        assert!(remux_bytes(Arc::from(&b"RIFF....AVI LIST"[..]), &target("avi.mkv")).is_err());
        assert!(!root.join("avi.mkv").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mp4_to_mp4_keeps_the_strict_byte_exact_path() {
        let source = filmcraft_lib::doc_fixtures::mp4_h264_aac();
        let root = remux_scratch("remux-strict");
        let output = root.join("same.mp4");
        // Both paths succeed on this fixture; the strict one must be the one chosen.
        let strict = {
            let strict_output = root.join("strict.mp4");
            remux_mp4(VideoInput::Bytes(source.clone().into()), &strict_output).unwrap();
            std::fs::read(strict_output).unwrap()
        };
        remux_bytes(source.into(), output.to_str().unwrap().as_bytes()).unwrap();
        assert_eq!(std::fs::read(output).unwrap(), strict);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hls_packaging_writes_a_playable_cmaf_ladder_and_refuses_existing_directories() {
        let source: Arc<[u8]> = filmcraft_lib::doc_fixtures::mp4_h264_aac().into();
        let root = remux_scratch("hls");
        let directory = root.join("out");
        let name = directory.to_str().unwrap().as_bytes().to_vec();
        let count = package_hls_bytes(Arc::clone(&source), &name, 500).unwrap();
        assert!(count >= 1);
        let init = std::fs::read(directory.join("init.mp4")).unwrap();
        assert_eq!(&init[4..8], b"ftyp");
        let playlist = std::fs::read_to_string(directory.join("playlist.m3u8")).unwrap();
        assert!(playlist.starts_with("#EXTM3U\n"));
        assert!(playlist.contains("#EXT-X-MAP:URI=\"init.mp4\""));
        assert!(playlist.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert_eq!(playlist.matches("#EXTINF:").count() as u64, count);

        // init + every segment is one fragmented MP4 holding every original packet.
        let mut joined = init;
        for index in 0..count {
            assert!(playlist.contains(&format!("segment-{index:05}.m4s")));
            joined
                .extend(std::fs::read(directory.join(format!("segment-{index:05}.m4s"))).unwrap());
        }
        let original = Demuxer::open_bytes(Arc::clone(&source), &demux_limits()).unwrap();
        let rebuilt = Demuxer::open_bytes(joined, &demux_limits()).unwrap();
        let packets = |demuxer: &Demuxer| {
            demuxer
                .tracks()
                .iter()
                .map(|track| track.packets)
                .collect::<Vec<_>>()
        };
        assert_eq!(packets(&rebuilt), packets(&original));

        let before = std::fs::read(directory.join("playlist.m3u8")).unwrap();
        assert!(package_hls_bytes(Arc::clone(&source), &name, 500).is_err());
        assert_eq!(
            std::fs::read(directory.join("playlist.m3u8")).unwrap(),
            before
        );
        for bad in [0, 499, 60_001] {
            assert!(matches!(
                package_hls_bytes(Arc::clone(&source), &target_name(&root, "bad"), bad),
                Err(VideoError::Invalid(_))
            ));
        }
        assert!(!root.join("bad").exists());
        assert!(
            package_hls_bytes(
                Arc::from(&b"not a media file"[..]),
                &target_name(&root, "junk"),
                500
            )
            .is_err()
        );
        assert!(!root.join("junk").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn target_name(root: &Path, name: &str) -> Vec<u8> {
        root.join(name).to_str().unwrap().as_bytes().to_vec()
    }

    #[test]
    fn declared_sample_explosion_is_rejected_before_owner_allocation() {
        fn boxed(kind: [u8; 4], body: &[u8]) -> Vec<u8> {
            let mut output = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            output.extend_from_slice(&kind);
            output.extend_from_slice(body);
            output
        }
        let mut table = vec![0u8; 8];
        table.extend_from_slice(&((MAX_SAMPLES + 1) as u32).to_be_bytes());
        let header = boxed(
            *b"moov",
            &boxed(
                *b"trak",
                &boxed(
                    *b"mdia",
                    &boxed(*b"minf", &boxed(*b"stbl", &boxed(*b"stsz", &table))),
                ),
            ),
        );
        let reader = MemReader(header.into());
        assert!(matches!(
            check_container_budget(&reader),
            Err(VideoError::Invalid(
                "MP4 declared sample count exceeds allocation budget"
            ))
        ));
    }

    // Container fixture only: its small H264-labelled payloads are not decoder conformance vectors.
    #[test]
    fn remux_preserves_access_units_timing_and_existing_output() {
        let mut writer =
            Mp4Writer::new(Cursor::new(Vec::new()), WriterOptions::new(Brand::Mp4)).unwrap();
        let entry = SampleEntry::avc(
            AvcConfig::new(vec![vec![0x67, 0x42, 0, 0x1e]], vec![vec![0x68, 0xce]], 4),
            64,
            48,
        );
        let track = writer.add_track(TrackConfig::new(entry, 24000)).unwrap();
        for number in 0..3u8 {
            writer
                .write_sample(
                    track,
                    WriteSample {
                        data: &[number; 16],
                        duration: 1001,
                        composition_offset: 0,
                        is_sync: number == 0,
                    },
                )
                .unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let root = std::env::temp_dir().join(format!("bun-video-filmcraft-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let output = root.join("remux.mp4");
        let result = remux_mp4(VideoInput::Bytes(bytes.clone().into()), &output);
        assert!(result.is_ok(), "{result:?}");
        let restored = std::fs::read(&output).unwrap();
        let before = filmcraft_isobmff::open(bytes.as_slice()).unwrap();
        let after = filmcraft_isobmff::open(restored.as_slice()).unwrap();
        assert_eq!(after.tracks.len(), before.tracks.len());
        assert_eq!(after.tracks[0].timescale, before.tracks[0].timescale);
        for (index, (a, b)) in before.tracks[0]
            .samples
            .iter()
            .zip(&after.tracks[0].samples)
            .enumerate()
        {
            assert_eq!(
                (a.dts, a.pts, a.duration, a.is_sync),
                (b.dts, b.pts, b.duration, b.is_sync)
            );
            assert_eq!(
                before.read_sample(bytes.as_slice(), 0, index).unwrap(),
                after.read_sample(restored.as_slice(), 0, index).unwrap()
            );
        }
        assert!(remux_mp4(VideoInput::Bytes(bytes.into()), &output).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), restored);
        std::fs::remove_file(output).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    #[ignore = "requires BUN_VIDEO_FILMCRAFT_TEST_VIDEO selecting an authorized local MP4, Matroska or WebM"]
    fn native_path_remuxes_a_real_source_to_matroska_keeping_its_frames() {
        let path =
            std::env::var_os("BUN_VIDEO_FILMCRAFT_TEST_VIDEO").expect("explicit fixture path");
        let path = Path::new(&path);
        let before = probe_video(VideoInput::Path(path), 3840 * 2160).unwrap();
        let root = remux_scratch("remux-real");
        let output = root.join("copy.mkv");
        let result = remux(VideoInput::Path(path), &output);
        let extension = path.extension().and_then(|value| value.to_str());
        if matches!(extension, Some("mp4" | "m4v" | "mov" | "mkv" | "webm")) {
            assert!(result.is_ok(), "{result:?}");
            let after = probe_video(VideoInput::Path(&output), 3840 * 2160).unwrap();
            assert_eq!(
                (after.width, after.height, after.frame_count),
                (before.width, before.height, before.frame_count)
            );
        } else {
            // The library remuxer reads MP4, QuickTime, Matroska and WebM only.
            assert!(result.is_err());
            assert!(!output.exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires BUN_VIDEO_FILMCRAFT_TEST_VIDEO selecting an authorized local H264 MP4"]
    fn native_path_decodes_a_real_source_and_advances_presentation_frames() {
        let path =
            std::env::var_os("BUN_VIDEO_FILMCRAFT_TEST_VIDEO").expect("explicit fixture path");
        let path = Path::new(&path);
        let metadata = probe_video(VideoInput::Path(path), 3840 * 2160).unwrap();
        assert!(metadata.width > 0 && metadata.height > 0);
        assert!(
            metadata
                .duration_seconds
                .is_some_and(|duration| duration > 0.0)
        );
        let mut session = VideoSession::open(VideoInput::Path(path), 3840 * 2160).unwrap();
        let first = session
            .next_frame()
            .unwrap()
            .expect("first presentation frame");
        let second = session
            .next_frame()
            .unwrap()
            .expect("second presentation frame");
        assert_eq!(
            first.rgba.len(),
            first.width as usize * first.height as usize * 4
        );
        assert!(second.timestamp_seconds > first.timestamp_seconds);
        let frame = session.frame(first.timestamp_seconds.max(0.0)).unwrap();
        let mut decoder = png::Decoder::new(Cursor::new(frame.png))
            .read_info()
            .unwrap();
        let mut png_rgba = vec![0; decoder.output_buffer_size()];
        let info = decoder.next_frame(&mut png_rgba).unwrap();
        assert_eq!((info.width, info.height), (first.width, first.height));
        assert_eq!(&png_rgba[..info.buffer_size()], first.rgba);
        assert!(session.cached_frames() <= MAX_CACHE_FRAMES);
        assert!(session.cached_bytes() <= MAX_CACHE_BYTES);
        assert!(session.frame(-1.0).is_err());
        if !metadata.audio_streams.is_empty() {
            let wav =
                encode_audio_wav(VideoInput::Path(path), 0.0, 0.1, 0, 16_000, 3840 * 2160).unwrap();
            assert_eq!(&wav[..4], b"RIFF");
            assert_eq!(&wav[8..12], b"WAVE");
            assert_eq!(&wav[36..40], b"data");
            assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
            assert_eq!(
                u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize,
                wav.len() - 44
            );
            assert_eq!(
                wav.len() - 44,
                1600 * metadata.audio_streams[0].channels as usize * 2
            );
        }
        let gif = encode_gif(VideoInput::Path(path), 0.0, 0.25, 12, 64, 3840 * 2160).unwrap();
        assert!(gif.starts_with(b"GIF89a"));
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut decoder = options.read_info(Cursor::new(gif)).unwrap();
        assert!(decoder.width() <= 64 && decoder.height() <= 360);
        let mut frames = 0;
        let mut delay = 0;
        while let Some(frame) = decoder.read_next_frame().unwrap() {
            frames += 1;
            delay += frame.delay;
        }
        assert_eq!(frames, 3);
        assert_eq!(delay, 25);
        session.cancel();
        assert!(matches!(session.next_frame(), Err(VideoError::Cancelled)));
    }
}

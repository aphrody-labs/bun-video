//! Typed streaming encoder commands; no shell, frame buffering, or automatic GPU fallback.
#![cfg_attr(windows, feature(windows_process_extensions_raw_attribute))]
#[cfg(feature = "filmcraft")]
pub mod filmcraft;
#[cfg(feature = "libav")]
pub mod libav;
#[cfg(feature = "libav")]
pub mod memory_io;
#[cfg(feature = "mpv")]
pub mod mpv_memory;
pub mod owned_process;
#[cfg(all(windows, feature = "libav"))]
mod windows_provider;
use owned_process::{OwnedChild, spawn_owned};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(feature = "gpu")]
use gpu_video::{VideoInstance, parameters::VideoInstanceDescriptor};

#[cfg(feature = "gpu")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuAdapterInfo {
    pub name: String,
    pub driver: String,
    pub device_type: String,
    pub supports_decoding: bool,
    pub supports_encoding: bool,
}

#[cfg(feature = "gpu")]
pub fn probe_gpu_adapters() -> Result<Vec<GpuAdapterInfo>, String> {
    let instance = VideoInstance::new(&VideoInstanceDescriptor::default())
        .map_err(|error| error.to_string())?;
    let adapters = instance
        .iter_adapters()
        .map_err(|error| error.to_string())?;
    Ok(adapters
        .map(|adapter| {
            let info = adapter.info();
            GpuAdapterInfo {
                name: info.name.clone(),
                driver: format!("{} {}", info.driver_name, info.driver_info),
                device_type: format!("{:?}", info.device_type),
                supports_decoding: adapter.supports_decoding(),
                supports_encoding: adapter.supports_encoding(),
            }
        })
        .collect())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Ffv1,
    Nvenc,
    Qsv,
    Amf,
}

impl Backend {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "ffv1" => Ok(Self::Ffv1),
            "nvenc" => Ok(Self::Nvenc),
            "qsv" => Ok(Self::Qsv),
            "amf" => Ok(Self::Amf),
            _ => Err("backend must be ffv1, nvenc, qsv or amf"),
        }
    }
    pub fn encoder(self) -> &'static str {
        match self {
            Self::Ffv1 => "ffv1",
            Self::Nvenc => "h264_nvenc",
            Self::Qsv => "h264_qsv",
            Self::Amf => "h264_amf",
        }
    }
}

#[derive(Debug)]
pub struct FrameRate {
    pub num: u32,
    pub den: u32,
}

impl std::str::FromStr for FrameRate {
    type Err = &'static str;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let (num, den) = value.split_once('/').unwrap_or((value, "1"));
        let rate = Self {
            num: num.parse().map_err(|_| "invalid FPS numerator")?,
            den: den.parse().map_err(|_| "invalid FPS denominator")?,
        };
        if rate.num == 0 || rate.den == 0 || u64::from(rate.num) > u64::from(rate.den) * 240 {
            return Err("FPS must be positive and at most 240");
        }
        Ok(rate)
    }
}

#[derive(Debug)]
pub struct EncodeOptions {
    pub fps: FrameRate,
    pub frames: u64,
    pub threads: u16,
    pub backend: Backend,
    pub allow_lossy: bool,
}

impl EncodeOptions {
    pub fn args(&self, output: &Path) -> Result<Vec<OsString>, &'static str> {
        if self.fps.num == 0
            || self.fps.den == 0
            || u64::from(self.fps.num) > u64::from(self.fps.den) * 240
            || self.frames == 0
            || self.threads == 0
            || self.threads > 256
        {
            return Err("positive fps <=240, frames > 0, threads 1..256 required");
        }
        if !output.is_absolute() {
            return Err("output path must be absolute");
        }
        if self.backend != Backend::Ffv1 && !self.allow_lossy {
            return Err("GPU H264 cannot preserve RGBA exactly; require explicit --allow-lossy");
        }
        let mut args: Vec<OsString> = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-n",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-framerate",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        args.push(format!("{}/{}", self.fps.num, self.fps.den).into());
        args.extend(
            ["-i", "pipe:0", "-an", "-frames:v"]
                .into_iter()
                .map(OsString::from),
        );
        args.push(self.frames.to_string().into());
        args.extend(["-threads"].into_iter().map(OsString::from));
        args.push(self.threads.to_string().into());
        args.extend(
            ["-c:v", self.backend.encoder()]
                .into_iter()
                .map(OsString::from),
        );
        if self.backend == Backend::Ffv1 {
            args.extend(
                [
                    "-level",
                    "3",
                    "-g",
                    "1",
                    "-slicecrc",
                    "1",
                    "-pix_fmt",
                    "bgra",
                    "-f",
                    "matroska",
                ]
                .into_iter()
                .map(OsString::from),
            );
        } else {
            args.extend(
                ["-pix_fmt", "yuv420p", "-f", "mp4"]
                    .into_iter()
                    .map(OsString::from),
            );
        }
        args.push(output.as_os_str().to_owned());
        Ok(args)
    }
    pub fn spawn(&self, ffmpeg: &OsStr, output: &Path) -> io::Result<OwnedChild> {
        let args = self
            .args(output)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        spawn_owned(
            Command::new(ffmpeg)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit()),
        )
    }
}

/// A listed encoder is insufficient: open it and encode one frame on the selected host.
pub fn probe_backend(ffmpeg: &OsStr, backend: Backend) -> io::Result<bool> {
    use std::io::Write;
    // Hardware encoders can reject tiny frames despite a functioning device.
    let pixels = vec![0; 256 * 256 * 4];
    let png = encode_rgba_png(256, 256, &pixels)?;
    let mut child = spawn_owned(
        Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "-framerate",
                "1",
                "-i",
                "pipe:0",
                "-frames:v",
                "1",
                "-c:v",
                backend.encoder(),
                "-f",
                "null",
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit()),
    )?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("probe stdin missing"))?;
    let written = input.write_all(&png);
    drop(input);
    let result = child.wait()?;
    if !result.success() {
        return Ok(false);
    }
    written?;
    Ok(result.success())
}

pub fn encode_rgba_png(width: u32, height: u32, pixels: &[u8]) -> io::Result<Vec<u8>> {
    let expected = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "RGBA dimensions overflow"))?;
    if width == 0 || height == 0 || expected != pixels.len() as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "RGBA dimensions do not match byte length",
        ));
    }
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut encoded, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(io::Error::other)?;
        writer.write_image_data(pixels).map_err(io::Error::other)?;
    }
    Ok(encoded)
}

pub fn probe_media(ffprobe: &OsStr, input: &Path) -> io::Result<std::process::Output> {
    if !input.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "input path must be absolute",
        ));
    }
    spawn_owned(
        Command::new(ffprobe)
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                "-i",
            ])
            .arg(input)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )?
    .wait_with_output()
}

/// Decoder stdout is a backpressured RGBA byte stream; probe dimensions separately.
pub fn spawn_decode_rgba(ffmpeg: &OsStr, input: &Path) -> io::Result<OwnedChild> {
    if !input.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "input path must be absolute",
        ));
    }
    spawn_owned(
        Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-i"])
            .arg(input)
            .args([
                "-map",
                "0:v:0",
                "-an",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()),
    )
}

#[cfg(feature = "libav")]
pub fn libav_encoder_present(backend: Backend) -> Result<bool, libav::VideoError> {
    libav::encoder_present(backend.encoder())
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "libav")]
    #[test]
    fn video_provider_probes_and_decodes_one_memory_frame_with_bounds() {
        use crate::libav::{
            VideoInput, decode_video_frame, decode_video_frame_with_cancel, probe_video,
        };
        use std::sync::{Arc, atomic::AtomicBool};
        let pixels = [255, 0, 0, 255, 0, 0, 255, 255];
        let source: Arc<[u8]> = encode_rgba_png(2, 1, &pixels).expect("fixture PNG").into();
        let metadata = probe_video(VideoInput::Bytes(source.clone()), 2).expect("probe PNG stream");
        assert_eq!((metadata.width, metadata.height), (2, 1));
        assert_eq!(metadata.codec, "png");
        let decoded = decode_video_frame(VideoInput::Bytes(source.clone()), 0.0, 2)
            .expect("decode selected frame");
        assert_eq!((decoded.width, decoded.height), (2, 1));
        let mut reader = png::Decoder::new(std::io::Cursor::new(decoded.png))
            .read_info()
            .expect("PNG result");
        let mut restored = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut restored).expect("PNG pixels");
        assert_eq!(&restored[..frame.buffer_size()], pixels);
        assert!(probe_video(VideoInput::Bytes(source.clone()), 1).is_err());
        assert!(decode_video_frame(VideoInput::Bytes(source.clone()), f64::NAN, 2).is_err());
        assert!(
            decode_video_frame_with_cancel(
                VideoInput::Bytes(source),
                0.0,
                2,
                Some(Arc::new(AtomicBool::new(true)))
            )
            .is_err()
        );
    }
    use super::*;
    #[cfg(feature = "libav")]
    #[test]
    fn direct_libav_ffv1_preserves_rgba_and_refuses_existing_output() {
        let path = std::env::temp_dir().join(format!(
            "bun-libav-{}-{}.mkv",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let opts = options();
        let mut rgba: Vec<u8> = (0u8..=255).cycle().take(64 * 64 * 4 * 2).collect();
        rgba[3] = 0;
        rgba[64 * 64 * 4 + 3] = 0;
        let pngs: Vec<u8> = rgba
            .as_chunks::<{ 64 * 64 * 4 }>()
            .0
            .iter()
            .flat_map(|frame| encode_rgba_png(64, 64, frame).unwrap())
            .collect();
        libav::encode_ffv1(&mut std::io::Cursor::new(&pngs), &path, &opts).unwrap();
        let mut decoded = Vec::new();
        assert_eq!(libav::decode_rgba(&path, &mut decoded).unwrap(), 2);
        assert_eq!(decoded, rgba);
        let source: std::sync::Arc<[u8]> = std::fs::read(&path).unwrap().into();
        let frame =
            libav::decode_video_frame(libav::VideoInput::Bytes(source), 0.03, 64 * 64).unwrap();
        assert!(frame.timestamp_seconds.is_some_and(|time| time >= 0.03));
        let mut reader = png::Decoder::new(std::io::Cursor::new(frame.png))
            .read_info()
            .unwrap();
        let mut selected = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut selected).unwrap();
        assert_eq!(&selected[..info.buffer_size()], &rgba[64 * 64 * 4..]);
        assert!(libav::encode_ffv1(&mut std::io::Cursor::new(&pngs), &path, &opts).is_err());
        std::fs::remove_file(path).unwrap();
    }
    fn output() -> std::path::PathBuf {
        std::env::temp_dir().join("bun-video-test.mkv")
    }
    fn options() -> EncodeOptions {
        EncodeOptions {
            fps: FrameRate { num: 30, den: 1 },
            frames: 2,
            threads: 2,
            backend: Backend::Ffv1,
            allow_lossy: false,
        }
    }
    #[test]
    fn exact_rgba_requires_lossless_rgb_alpha_codec() {
        let args = options().args(&output()).expect("valid command");
        assert!(
            args.windows(2)
                .any(|a| a == [OsString::from("-pix_fmt"), OsString::from("bgra")])
        );
        assert!(
            args.windows(2)
                .any(|a| a == [OsString::from("-f"), OsString::from("matroska")])
        );
        for backend in [Backend::Nvenc, Backend::Qsv, Backend::Amf] {
            let mut opts = options();
            opts.backend = backend;
            assert!(opts.args(&output()).is_err());
            opts.allow_lossy = true;
            assert!(opts.args(&output()).is_ok());
        }
    }
    #[test]
    fn rejects_invalid_rate_count_and_relative_path() {
        let mut opts = options();
        opts.fps.num = 0;
        assert!(opts.args(&output()).is_err());
        opts = options();
        opts.frames = 0;
        assert!(opts.args(&output()).is_err());
        assert!(options().args(Path::new("relative.mkv")).is_err());
    }
    #[test]
    fn rational_frame_rate_keeps_ntsc_ratio_exact() {
        let mut opts = options();
        opts.fps = "30000/1001".parse().expect("NTSC rate");
        let args = opts.args(&output()).expect("NTSC args");
        assert!(
            args.windows(2)
                .any(|a| a == [OsString::from("-framerate"), OsString::from("30000/1001")])
        );
        for value in ["0", "30/0", "241", "1/2/3", "-1", "4294967296"] {
            assert!(value.parse::<FrameRate>().is_err());
        }
        assert_eq!("30".parse::<FrameRate>().expect("integer FPS").den, 1);
    }
    #[test]
    fn output_is_one_literal_argument() {
        let path = std::env::temp_dir().join("literal ; $ video.mkv");
        let args = options().args(&path).expect("valid path");
        assert_eq!(args.last(), Some(&path.as_os_str().to_owned()));
        assert!(Backend::parse("sh -c exploit").is_err());
    }

    #[test]
    fn png_fixture_preserves_rgba_without_native_sdk() {
        let mut pixels: Vec<u8> = (0u8..=255).cycle().take(64 * 64 * 4).collect();
        pixels[3] = 0;
        let png = encode_rgba_png(64, 64, &pixels).expect("RGBA PNG");
        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let mut reader = decoder.read_info().expect("PNG header");
        let mut decoded = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut decoded).expect("PNG pixels");
        assert_eq!(info.color_type, png::ColorType::Rgba);
        assert_eq!(&decoded[..info.buffer_size()], pixels);
        assert!(encode_rgba_png(0, 64, &pixels).is_err());
        assert!(encode_rgba_png(u32::MAX, u32::MAX, &[]).is_err());
    }

    #[test]
    #[ignore = "requires qualified FFmpeg; run explicitly in the final integration gate"]
    fn ffv1_preserves_every_rgba_byte_including_transparent_pixels() {
        use std::io::Write;
        let ffmpeg =
            std::env::var_os("BUN_VIDEO_FFMPEG").expect("set absolute BUN_VIDEO_FFMPEG path");
        let mut pixels: Vec<u8> = (0u8..=255).cycle().take(64 * 64 * 4 * 2).collect();
        pixels[3] = 0;
        pixels[64 * 64 * 4 + 3] = 0;
        let input: Vec<u8> = pixels
            .as_chunks::<{ 64 * 64 * 4 }>()
            .0
            .iter()
            .flat_map(|frame| encode_rgba_png(64, 64, frame).expect("encode source PNG"))
            .collect();
        let mut encode = spawn_owned(
            Command::new(&ffmpeg)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "image2pipe",
                    "-vcodec",
                    "png",
                    "-framerate",
                    "30",
                    "-i",
                    "pipe:0",
                    "-frames:v",
                    "2",
                    "-c:v",
                    "ffv1",
                    "-level",
                    "3",
                    "-pix_fmt",
                    "bgra",
                    "-f",
                    "matroska",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit()),
        )
        .expect("spawn encoder");
        let mut stdin = encode.stdin.take().expect("encoder stdin");
        let writer = std::thread::spawn(move || stdin.write_all(&input));
        let encoded = encode.wait_with_output().expect("wait encoder");
        writer.join().expect("writer thread").expect("write pixels");
        assert!(encoded.status.success());
        let mut decode = spawn_owned(
            Command::new(&ffmpeg)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    "pipe:0",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgba",
                    "pipe:1",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit()),
        )
        .expect("spawn decoder");
        let mut stdin = decode.stdin.take().expect("decoder stdin");
        let writer = std::thread::spawn(move || stdin.write_all(&encoded.stdout));
        let decoded = decode.wait_with_output().expect("wait decoder");
        writer
            .join()
            .expect("writer thread")
            .expect("write encoded stream");
        assert_eq!(decoded.stdout, pixels);
        assert!(decoded.status.success());
    }
}

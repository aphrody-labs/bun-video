#[cfg(not(feature = "libav"))]
use bun_video_native::spawn_decode_rgba;
use bun_video_native::{Backend, EncodeOptions, probe_backend, probe_media};
use std::ffi::OsStr;
use std::io;
use std::path::PathBuf;

#[cfg(feature = "filmcraft-encode")]
struct TimedInput {
    receiver: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>,
    pending: io::Cursor<Vec<u8>>,
    deadline: std::time::Instant,
}

#[cfg(feature = "filmcraft-encode")]
impl io::Read for TimedInput {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() { return Ok(0); }
        let remaining = self.deadline.checked_duration_since(std::time::Instant::now())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "RGBA input deadline expired"))?;
        if self.pending.position() < self.pending.get_ref().len() as u64 {
            return io::Read::read(&mut self.pending, output);
        }
        match self.receiver.recv_timeout(remaining) {
            Ok(bytes) => { self.pending = io::Cursor::new(bytes?); io::Read::read(&mut self.pending, output) }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(0),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(io::Error::new(io::ErrorKind::TimedOut, "RGBA input deadline expired")),
        }
    }
}

#[cfg(feature = "filmcraft-encode")]
fn timed_stdin() -> io::Result<TimedInput> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    // A CLI-only reader thread bounds pipe buffering. On timeout main exits and the OS closes stdin.
    let _reader = std::thread::Builder::new().name("rgba-stdin".into()).spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut bytes = vec![0; 64 * 1024];
            let result = match io::Read::read(&mut input, &mut bytes) {
                Ok(0) => break,
                Ok(size) => { bytes.truncate(size); Ok(bytes) }
                Err(error) => Err(error),
            };
            let failed = result.is_err();
            if sender.send(result).is_err() || failed { break; }
        }
    })?;
    Ok(TimedInput { receiver, pending: io::Cursor::new(Vec::new()), deadline: std::time::Instant::now() + std::time::Duration::from_secs(180) })
}

#[cfg(all(test, feature = "filmcraft-encode"))]
mod timed_input_tests {
    use super::TimedInput;
    use std::io::{self, Read};
    use std::sync::mpsc::sync_channel;
    use std::time::{Duration, Instant};

    #[test]
    fn bounded_chunks_preserve_bytes_and_eof() {
        let (sender, receiver) = sync_channel(2);
        sender.send(Ok(vec![1, 2, 3])).expect("fixture receiver");
        sender.send(Ok(vec![4, 5])).expect("fixture receiver");
        drop(sender);
        let mut input = TimedInput { receiver, pending: io::Cursor::new(Vec::new()), deadline: Instant::now() + Duration::from_secs(5) };
        let mut bytes = [0; 5];
        input.read_exact(&mut bytes).expect("bounded input");
        assert_eq!(bytes, [1, 2, 3, 4, 5]);
        assert_eq!(input.read(&mut bytes).expect("EOF"), 0);
    }

    #[test]
    fn stalled_input_expires_without_waiting_for_eof() {
        let (_sender, receiver) = sync_channel(1);
        let mut input = TimedInput { receiver, pending: io::Cursor::new(Vec::new()), deadline: Instant::now() - Duration::from_secs(1) };
        assert_eq!(input.read(&mut [0]).expect_err("expired input").kind(), io::ErrorKind::TimedOut);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ffmpeg = std::env::var_os("BUN_VIDEO_FFMPEG").unwrap_or_else(|| "ffmpeg".into());
    match args.first().map(String::as_str) {
        #[cfg(feature = "filmcraft-encode")]
        Some("filmcraft-encode") if args.len() == 6 => {
            let width: u32 = args[1].parse()?;
            let height: u32 = args[2].parse()?;
            let (num, den) = args[3].split_once('/').ok_or("FPS requires numerator/denominator")?;
            let fps = filmcraft_lib::FrameRate { num: num.parse()?, den: den.parse()? };
            let frames: usize = args[4].parse()?;
            let output = PathBuf::from(&args[5]);
            let bytes = bun_video_native::filmcraft::encode_rgba_stream(
                &mut timed_stdin()?, &output, width, height, fps, frames,
            )?;
            println!("{{\"provider\":\"filmcraft\",\"codec\":\"h264\",\"frames\":{frames},\"bytes\":{bytes}}}");
        }
        Some("probe") => {
            for backend in [Backend::Ffv1, Backend::Nvenc, Backend::Qsv, Backend::Amf] {
                let ready = probe_backend(&ffmpeg, backend)?;
                println!("{{\"encoder\":\"{}\",\"runtimeReady\":{ready},\"exactRgba\":{}}}", backend.encoder(), backend == Backend::Ffv1);
            }
        }
        #[cfg(feature = "gpu")]
        Some("gpu-info") => {
            let adapters = bun_video_native::probe_gpu_adapters().map_err(io::Error::other)?;
            for adapter in adapters {
                println!(
                    "{{\"name\":{},\"driver\":{},\"deviceType\":{},\"supportsDecoding\":{},\"supportsEncoding\":{}}}",
                    json_string(&adapter.name),
                    json_string(&adapter.driver),
                    json_string(&adapter.device_type),
                    adapter.supports_decoding,
                    adapter.supports_encoding,
                );
            }
        }
        Some("media") if args.len() == 2 => {
            use std::io::Write;
            let ffprobe = std::env::var_os("BUN_VIDEO_FFPROBE").unwrap_or_else(|| "ffprobe".into());
            let output = probe_media(&ffprobe, &PathBuf::from(&args[1]))?;
            if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into_owned().into()); }
            io::stdout().lock().write_all(&output.stdout)?;
        }
        Some("decode") if args.len() == 2 => {
            #[cfg(feature = "libav")]
            bun_video_native::libav::decode_rgba(&PathBuf::from(&args[1]), &mut io::stdout().lock())?;
            #[cfg(not(feature = "libav"))]
            {
            let mut child = spawn_decode_rgba(&ffmpeg, &PathBuf::from(&args[1]))?;
            let result = io::copy(&mut child.stdout.take().ok_or("decoder stdout unavailable")?, &mut io::stdout().lock());
            if let Err(error) = result { let _ = child.kill(); let _ = child.wait(); return Err(error.into()); }
            if !child.wait()?.success() { return Err("FFmpeg decode failed".into()); }
            }
        }
        Some("encode") if args.len() == 6 || args.len() == 7 => {
            let allow_lossy = args.len() == 7 && args[6] == "--allow-lossy";
            if args.len() == 7 && !allow_lossy { return Err("unknown flag".into()); }
            let opts = EncodeOptions { backend: Backend::parse(&args[1])?, fps: args[2].parse()?, frames: args[3].parse()?, threads: args[4].parse()?, allow_lossy };
            let path = PathBuf::from(&args[5]);
            opts.args(&path)?;
            #[cfg(feature = "libav")]
            if opts.backend == Backend::Ffv1 {
                bun_video_native::libav::encode_ffv1(&mut io::stdin().lock(), &path, &opts)?;
                return Ok(());
            }
            if opts.backend != Backend::Ffv1 && !probe_backend(&ffmpeg, opts.backend)? { return Err("requested GPU encoder unavailable on this host".into()); }
            let mut child = opts.spawn(OsStr::new(&ffmpeg), &path)?;
            let result = {
                let mut input = child.stdin.take().ok_or("encoder stdin unavailable")?;
                io::copy(&mut io::stdin().lock(), &mut input)
            };
            if let Err(error) = result { let _ = child.kill(); let _ = child.wait(); return Err(error.into()); }
            if !child.wait()?.success() { return Err("FFmpeg encode failed".into()); }
        }
        _ => return Err("usage: bun-video-native probe | gpu-info | media ABS_INPUT | decode ABS_INPUT | encode ffv1|nvenc|qsv|amf FPS FRAMES THREADS ABS_OUTPUT [--allow-lossy]; stdin: concatenated PNG frames".into()),
    }
    Ok(())
}

#[cfg(feature = "gpu")]
fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04x}", character as u32))
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

fn main() {
    if let Err(error) = run() {
        eprintln!("bun-video-native: {error}");
        std::process::exit(1);
    }
}

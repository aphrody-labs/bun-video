use ffmpeg_sys_next as ffi;
use std::{
    ffi::c_void,
    ptr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const INVALID: i32 = -22;
const NO_MEMORY: i32 = -12;
const EOF: i32 = -541_478_725;
const MAX_BYTES: usize = 512 * 1024 * 1024;

struct Source {
    data: Arc<[u8]>,
    position: usize,
    budget: InterruptBudget,
}

#[derive(Clone)]
pub(crate) struct InterruptBudget {
    cancel: Option<Arc<AtomicBool>>,
    deadline: Instant,
}

impl InterruptBudget {
    pub(crate) fn new(cancel: Option<Arc<AtomicBool>>) -> Self {
        Self {
            cancel,
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }
    pub(crate) fn stopped(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
            || Instant::now() >= self.deadline
    }
}

pub(crate) unsafe extern "C" fn interrupt(opaque: *mut c_void) -> i32 {
    if opaque.is_null() {
        return 1;
    }
    // SAFETY: the input owner pins this budget until avformat_close_input returns.
    i32::from(unsafe { &*opaque.cast::<InterruptBudget>() }.stopped())
}

pub struct MemoryInput {
    format: *mut ffi::AVFormatContext,
    io: *mut ffi::AVIOContext,
    source: *mut Source,
    pending_buffer: *mut u8,
}

unsafe extern "C" fn read(opaque: *mut c_void, output: *mut u8, size: i32) -> i32 {
    if opaque.is_null() || output.is_null() || size <= 0 {
        return INVALID;
    }
    // SAFETY: AVIO stores our live Source pointer and supplies a buffer of `size` bytes.
    let source = unsafe { &mut *opaque.cast::<Source>() };
    if source.budget.stopped() {
        return ffi::AVERROR_EXIT;
    }
    if source.position >= source.data.len() {
        return EOF;
    }
    let count = (size as usize).min(source.data.len() - source.position);
    // SAFETY: count is bounded by both remaining source bytes and the AVIO destination size.
    unsafe { ptr::copy_nonoverlapping(source.data.as_ptr().add(source.position), output, count) };
    source.position += count;
    count as i32
}

unsafe extern "C" fn seek(opaque: *mut c_void, offset: i64, whence: i32) -> i64 {
    if opaque.is_null() {
        return i64::from(INVALID);
    }
    // SAFETY: the callback is invoked only while our owned AVIO Source is alive.
    let source = unsafe { &mut *opaque.cast::<Source>() };
    if source.budget.stopped() {
        return i64::from(ffi::AVERROR_EXIT);
    }
    if whence & ffi::AVSEEK_SIZE != 0 {
        return source.data.len() as i64;
    }
    let origin = match whence & !ffi::AVSEEK_FORCE {
        0 => 0,
        1 => source.position,
        2 => source.data.len(),
        _ => return i64::from(INVALID),
    };
    let position = origin as i128 + i128::from(offset);
    if position < 0 || position > source.data.len() as i128 {
        return i64::from(INVALID);
    }
    source.position = position as usize;
    position as i64
}

impl MemoryInput {
    #[cfg(feature = "mpv")]
    pub(crate) fn copy_bytes(&self) -> Result<Vec<u8>, i32> {
        // SAFETY: a constructed MemoryInput owns its source and byte allocation through this borrow.
        let source = unsafe { &*self.source };
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(source.data.len())
            .map_err(|_| NO_MEMORY)?;
        // SAFETY: the owned source allocation contains exactly length readable bytes.
        bytes.extend_from_slice(&source.data);
        Ok(bytes)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, i32> {
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(INVALID);
        }
        Self::from_owned_bytes(Arc::from(bytes), None, 67_108_864)
    }
    pub(crate) fn format(&self) -> *mut ffi::AVFormatContext {
        self.format
    }
    pub(crate) fn stopped(&self) -> bool {
        // SAFETY: successful construction owns a live source until Drop.
        unsafe { &*self.source }.budget.stopped()
    }
    pub(crate) fn from_owned_bytes(
        bytes: Arc<[u8]>,
        cancel: Option<Arc<AtomicBool>>,
        max_pixels: u64,
    ) -> Result<Self, i32> {
        if crate::libav::verify_abi().is_err() {
            return Err(INVALID);
        }
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(INVALID);
        }
        let budget = InterruptBudget::new(cancel);
        if budget.stopped() {
            return Err(ffi::AVERROR_EXIT);
        }
        let mut input = Self {
            format: ptr::null_mut(),
            io: ptr::null_mut(),
            source: ptr::null_mut(),
            pending_buffer: ptr::null_mut(),
        };
        // SAFETY: fixed-size allocations and the validated byte length are checked before use.
        unsafe {
            input.source = Box::into_raw(Box::new(Source {
                data: bytes,
                position: 0,
                budget,
            }));
            input.format = ffi::avformat_alloc_context();
            input.pending_buffer = ffi::av_malloc(32768).cast();
            if input.format.is_null() || input.pending_buffer.is_null() {
                return Err(NO_MEMORY);
            }
            input.io = ffi::avio_alloc_context(
                input.pending_buffer,
                32768,
                0,
                input.source.cast(),
                Some(read),
                None,
                Some(seek),
            );
            if input.io.is_null() {
                return Err(NO_MEMORY);
            }
            input.pending_buffer = ptr::null_mut();
            (*input.format).pb = input.io;
            (*input.format).flags |= ffi::AVFMT_FLAG_CUSTOM_IO;
            (*input.format).interrupt_callback = ffi::AVIOInterruptCB {
                callback: Some(interrupt),
                opaque: ptr::addr_of_mut!((*input.source).budget).cast(),
            };
            (*input.format).probesize = 8 * 1024 * 1024;
            (*input.format).max_analyze_duration = 5_000_000;
            (*input.format).max_streams = 128;
            (*input.format).max_picture_buffer = 256 * 1024 * 1024;
            let mut options = ptr::null_mut();
            let option_status = ffi::av_dict_set(
                &mut options,
                c"protocol_whitelist".as_ptr(),
                c"data".as_ptr(),
                0,
            );
            if option_status < 0 {
                ffi::av_dict_free(&mut options);
                return Err(option_status);
            }
            let status =
                ffi::avformat_open_input(&mut input.format, ptr::null(), ptr::null(), &mut options);
            ffi::av_dict_free(&mut options);
            if status < 0 {
                return Err(status);
            }
            let status = find_stream_info(input.format, max_pixels);
            if status < 0 {
                return Err(status);
            }
        }
        Ok(input)
    }
}

pub(crate) unsafe fn find_stream_info(format: *mut ffi::AVFormatContext, max_pixels: u64) -> i32 {
    if max_pixels == 0 || max_pixels > 268_435_456 {
        return INVALID;
    }
    let streams = unsafe { (*format).nb_streams as usize };
    if streams == 0 || streams > 128 {
        return INVALID;
    }
    let limit = std::ffi::CString::new(max_pixels.to_string()).expect("decimal pixel limit");
    let mut options = vec![ptr::null_mut(); streams];
    let mut result = 0;
    unsafe {
        for option in &mut options {
            result = ffi::av_dict_set(option, c"max_pixels".as_ptr(), limit.as_ptr(), 0);
            if result < 0 {
                break;
            }
        }
        if result >= 0 {
            result = ffi::avformat_find_stream_info(format, options.as_mut_ptr());
        }
        for option in &mut options {
            ffi::av_dict_free(option);
        }
    }
    result
}

impl Drop for MemoryInput {
    fn drop(&mut self) {
        // SAFETY: all pointers are either null or owned allocations; custom AVIO is freed after demuxing.
        unsafe {
            ffi::avformat_close_input(&mut self.format);
            if !self.io.is_null() {
                ffi::av_free((*self.io).buffer.cast());
                (*self.io).buffer = ptr::null_mut();
                ffi::avio_context_free(&mut self.io);
            }
            ffi::av_free(self.pending_buffer.cast());
            if !self.source.is_null() {
                drop(Box::from_raw(self.source));
            }
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_video_memory_api_version() -> u32 {
    1
}

/// # Safety
/// `data` must reference `length` readable bytes; `output` must be a writable pointer slot.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_video_memory_open(
    data: *const u8,
    length: usize,
    output: *mut *mut MemoryInput,
) -> i32 {
    if output.is_null() {
        return INVALID;
    }
    // SAFETY: the caller supplies a writable output slot.
    unsafe {
        *output = ptr::null_mut();
    }
    if data.is_null() || length == 0 || length > MAX_BYTES {
        return INVALID;
    }
    // SAFETY: the FFI caller guarantees the validated readable range for this synchronous call.
    let bytes = unsafe { std::slice::from_raw_parts(data, length) };
    let input = match MemoryInput::from_bytes(bytes) {
        Ok(input) => input,
        Err(status) => return status,
    };
    // SAFETY: allocate an aligned fixed-size owner and transfer its initialized value exactly once.
    unsafe {
        let owned = ffi::av_malloc(std::mem::size_of::<MemoryInput>()).cast::<MemoryInput>();
        if owned.is_null() {
            return NO_MEMORY;
        }
        ptr::write(owned, input);
        *output = owned;
    }
    0
}

/// # Safety
/// `input` must be null or a live handle returned by `bun_video_memory_open`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_video_memory_format(
    input: *const MemoryInput,
) -> *mut ffi::AVFormatContext {
    if input.is_null() {
        return ptr::null_mut();
    }
    // SAFETY: the caller retains the memory-input owner for the returned context's entire use.
    unsafe { (*input).format }
}

/// # Safety
/// `input` must be a writable slot containing null or a uniquely owned live memory-input handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_video_memory_close(input: *mut *mut MemoryInput) {
    if input.is_null() {
        return;
    }
    // SAFETY: the caller transfers unique ownership and keeps the slot writable through disposal.
    unsafe {
        let owned = *input;
        *input = ptr::null_mut();
        if !owned.is_null() {
            ptr::drop_in_place(owned);
            ffi::av_free(owned.cast());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_bounds_seek_and_eof() {
        let mut source = Source {
            data: Arc::from([1u8, 2, 3]),
            position: 0,
            budget: InterruptBudget::new(None),
        };
        let opaque = (&mut source as *mut Source).cast();
        let mut output = [0; 2];
        // SAFETY: the stack-owned source and both buffers remain live throughout these synchronous calls.
        unsafe {
            assert_eq!(read(opaque, output.as_mut_ptr(), 2), 2);
            assert_eq!(output, [1, 2]);
            assert_eq!(read(opaque, output.as_mut_ptr(), 2), 1);
            assert_eq!(read(opaque, output.as_mut_ptr(), 2), EOF);
            assert_eq!(seek(opaque, 0, ffi::AVSEEK_SIZE), 3);
            assert_eq!(seek(opaque, i64::MAX, 1), i64::from(INVALID));
            assert_eq!(seek(opaque, -1, 0), i64::from(INVALID));
            assert_eq!(seek(opaque, 0, 0), 0);
            assert_eq!(read(opaque, output.as_mut_ptr(), 0), INVALID);
        }
    }

    #[test]
    fn callback_cancellation_and_deadline_never_advance_source() {
        let cancel = Arc::new(AtomicBool::new(true));
        let mut source = Source {
            data: Arc::from([1u8, 2, 3]),
            position: 0,
            budget: InterruptBudget::new(Some(cancel.clone())),
        };
        let opaque = (&raw mut source).cast();
        let mut bytes = [0u8; 2];
        unsafe {
            assert_eq!(read(opaque, bytes.as_mut_ptr(), 2), ffi::AVERROR_EXIT);
            assert_eq!(seek(opaque, 1, 0), i64::from(ffi::AVERROR_EXIT));
            assert_eq!(interrupt((&raw mut source.budget).cast()), 1);
        }
        assert_eq!(source.position, 0);
        assert_eq!(bytes, [0, 0]);
        cancel.store(false, Ordering::Relaxed);
        source.budget.deadline = Instant::now() - Duration::from_secs(1);
        assert_eq!(
            unsafe { read(opaque, bytes.as_mut_ptr(), 2) },
            ffi::AVERROR_EXIT
        );
        assert_eq!(source.position, 0);
    }

    #[test]
    fn malformed_input_leaves_no_ffi_owner() {
        let bytes = b"not a media container";
        let mut output = ptr::null_mut();
        // SAFETY: byte storage and output slot are valid; a rejected input never publishes an owner.
        unsafe {
            assert!(bun_video_memory_open(bytes.as_ptr(), bytes.len(), &mut output) < 0);
            assert!(output.is_null());
            bun_video_memory_close(&mut output);
            assert!(bun_video_memory_format(output).is_null());
        }
    }

    #[test]
    fn demuxer_owns_a_copy_of_the_input() {
        let mut bytes = [0u8; 46];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&38u32.to_le_bytes());
        bytes[8..16].copy_from_slice(b"WAVEfmt ");
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&8000u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&16000u32.to_le_bytes());
        bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
        bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&2u32.to_le_bytes());
        let input = MemoryInput::from_bytes(&bytes).expect("synthetic WAV");
        bytes.fill(255);
        // SAFETY: the demuxer and allocated packet remain owned and live until their corresponding frees.
        unsafe {
            let mut packet = ffi::av_packet_alloc();
            assert!(!packet.is_null());
            assert_eq!(ffi::av_read_frame(input.format, packet), 0);
            assert_eq!((*packet).size, 2);
            assert_eq!(std::slice::from_raw_parts((*packet).data, 2), &[0, 0]);
            ffi::av_packet_unref(packet);
            assert_eq!(ffi::av_read_frame(input.format, packet), EOF);
            ffi::av_packet_free(&mut packet);
        }
    }
}

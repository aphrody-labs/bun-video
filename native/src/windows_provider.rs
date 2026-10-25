use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{CStr, c_char, c_void},
    io::Read,
    path::{Path, PathBuf},
    ptr,
    sync::{Mutex, OnceLock},
};
use windows_sys::Win32::{
    Foundation::{FreeLibrary, GetLastError, HMODULE},
    System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
        LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
    },
};

struct Library(HMODULE);
// Windows module handles belong to the process and stay loaded while this owner is retained.
unsafe impl Send for Library {}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            FreeLibrary(self.0);
        }
    }
}
static MODULES: OnceLock<Mutex<Option<BTreeMap<String, Library>>>> = OnceLock::new();
const MANIFEST: &str = include_str!("../../src/sdk-manifest.json");

fn names() -> [String; 4] {
    [
        format!("avutil-{}.dll", env!("BUN_VIDEO_LIBAVUTIL_MAJOR")),
        format!("avcodec-{}.dll", env!("BUN_VIDEO_LIBAVCODEC_MAJOR")),
        format!("avformat-{}.dll", env!("BUN_VIDEO_LIBAVFORMAT_MAJOR")),
        format!("swscale-{}.dll", env!("BUN_VIDEO_LIBSWSCALE_MAJOR")),
    ]
}
fn sdk_prefix() -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os("BUN_VIDEO_MEDIA_DIR") {
        let directory = PathBuf::from(directory);
        if !directory.is_absolute() {
            return Err("BUN_VIDEO_MEDIA_DIR must be an absolute SDK directory".into());
        }
        if directory.join("bun-sdk-receipt.json").is_file() {
            return Ok(directory);
        }
        return directory
            .parent()
            .map(Path::to_path_buf)
            .ok_or("Invalid SDK library directory".into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let target = if cfg!(target_arch = "x86_64") {
        "windows-x64"
    } else {
        "windows-arm64"
    };
    Ok(executable
        .parent()
        .ok_or("Executable has no SDK parent")?
        .join("lib/media/ffmpeg")
        .join(target))
}
fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("SDK input must be a bounded regular file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| error.to_string())?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("SDK input exceeds its byte limit".into());
    }
    Ok(bytes)
}
struct VerifiedDll {
    name: String,
    path: PathBuf,
    _file: std::fs::File,
}
fn verified_dlls(prefix: &Path) -> Result<Vec<VerifiedDll>, String> {
    let prefix = prefix.canonicalize().map_err(|error| error.to_string())?;
    let receipt: serde_json::Value = serde_json::from_slice(&bounded_read(
        &prefix.join("bun-sdk-receipt.json"),
        1024 * 1024,
    )?)
    .map_err(|_| "Invalid FFmpeg SDK receipt")?;
    let manifest: serde_json::Value =
        serde_json::from_str(MANIFEST).map_err(|_| "Invalid built-in SDK manifest")?;
    let target = if cfg!(target_arch = "x86_64") {
        "windows-x64"
    } else {
        "windows-arm64"
    };
    let descriptor = manifest
        .get("targets")
        .and_then(|targets| targets.get(target))
        .and_then(|target| target.get("ffmpeg"))
        .ok_or("No FFmpeg SDK is qualified for this target")?;
    if receipt.get("schema").and_then(serde_json::Value::as_u64) != Some(1)
        || receipt.get("component").and_then(serde_json::Value::as_str) != Some("ffmpeg")
        || receipt.get("target").and_then(serde_json::Value::as_str) != Some(target)
        || receipt.get("sourceRevision") != descriptor.get("sourceRevision")
        || receipt.get("version") != descriptor.get("version")
    {
        return Err("FFmpeg SDK receipt differs from the compiled source/target contract".into());
    }
    let files = receipt
        .get("files")
        .and_then(serde_json::Value::as_object)
        .ok_or("SDK receipt has no file hashes")?;
    let expected = names();
    let mut verified = Vec::new();
    let mut total_bytes = 0u64;
    for (relative, hash) in files {
        if !relative.starts_with("bin/") || !relative.to_ascii_lowercase().ends_with(".dll") {
            continue;
        }
        let name = relative.strip_prefix("bin/").unwrap();
        if name.is_empty() || name.contains(['/', '\\', ':', '\0']) {
            return Err("Invalid SDK DLL receipt path".into());
        }
        let path = prefix.join("bin").join(name);
        let hash = hash.as_str().ok_or("Invalid SDK DLL hash")?;
        use std::os::windows::fs::OpenOptionsExt;
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
            return Err("SDK DLL must be a bounded regular file".into());
        }
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        if path.strip_prefix(&prefix).is_err() {
            return Err("SDK DLL resolved outside its canonical owner directory".into());
        }
        total_bytes = total_bytes
            .checked_add(metadata.len())
            .filter(|total| *total <= 512 * 1024 * 1024)
            .ok_or("SDK DLL verification exceeds its total byte budget")?;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(256 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 256 * 1024 * 1024 {
            return Err("SDK DLL exceeds byte limit".into());
        }
        let actual = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual != hash {
            return Err(format!("FFmpeg SDK DLL hash differs: {name}"));
        }
        verified.push(VerifiedDll {
            name: name.to_ascii_lowercase(),
            path,
            _file: file,
        });
        if verified.len() > 128 {
            return Err("SDK DLL count exceeds its limit".into());
        }
    }
    if expected
        .iter()
        .any(|name| !verified.iter().any(|actual| &actual.name == name))
    {
        return Err("FFmpeg SDK is missing a required provider DLL".into());
    }
    for entry in std::fs::read_dir(prefix.join("bin")).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".dll") && !verified.iter().any(|file| file.name == name) {
            return Err("SDK bin contains an unregistered DLL".into());
        }
    }
    Ok(verified)
}

pub(crate) fn ensure_loaded() -> Result<(), String> {
    let mut modules = MODULES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "SDK loader guard unavailable")?;
    if modules.is_some() {
        return Ok(());
    }
    let prefix = sdk_prefix()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let verified = verified_dlls(&prefix)?;
    check_existing_modules(&verified)?;
    let mut loaded = BTreeMap::new();
    for name in names() {
        let path = &verified
            .iter()
            .find(|actual| actual.name == name)
            .ok_or("Required DLL disappeared from its receipt")?
            .path;
        use std::os::windows::ffi::OsStrExt;
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // Only this absolute DLL's directory and System32 resolve its dependencies; no process search path is changed.
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            )
        };
        if module.is_null() {
            return Err(format!(
                "Cannot load qualified FFmpeg DLL {name} (Win32 {})",
                unsafe { GetLastError() }
            ));
        }
        loaded.insert(name, Library(module));
    }
    check_existing_modules(&verified)?;
    *modules = Some(loaded);
    Ok(())
}

fn check_existing_modules(files: &[VerifiedDll]) -> Result<(), String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    for file in files {
        let name = std::ffi::OsStr::new(&file.name)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut module = ptr::null_mut();
        if unsafe { GetModuleHandleExW(0, name.as_ptr(), &mut module) } == 0 {
            continue;
        }
        let module = Library(module);
        let mut path = vec![0u16; 32768];
        let count =
            unsafe { GetModuleFileNameW(module.0, path.as_mut_ptr(), path.len() as u32) } as usize;
        if count == 0 || count >= path.len() {
            return Err("Cannot verify an existing SDK module path".into());
        }
        let loaded = PathBuf::from(std::ffi::OsString::from_wide(&path[..count]))
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let expected = file
            .path
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !loaded
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
        {
            return Err(format!(
                "An incompatible FFmpeg module is already loaded: {}",
                file.name
            ));
        }
    }
    Ok(())
}

/// # Safety
/// name is a NUL-terminated DLL name supplied by delayimp. Returned handles remain process-owned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn BunVideoDelayLoadLibrary(
    name: *const c_char,
    recognized: *mut bool,
) -> *mut c_void {
    if name.is_null() || recognized.is_null() {
        return ptr::null_mut();
    }
    let name = unsafe { CStr::from_ptr(name) }
        .to_string_lossy()
        .to_ascii_lowercase();
    let ours = names().iter().any(|expected| expected == &name);
    unsafe {
        *recognized = ours;
    }
    if !ours {
        return ptr::null_mut();
    }
    if ensure_loaded().is_err() {
        return ptr::null_mut();
    }
    MODULES
        .get()
        .and_then(|modules| modules.lock().ok())
        .and_then(|modules| {
            modules
                .as_ref()
                .and_then(|modules| modules.get(&name))
                .map(|module| module.0)
        })
        .unwrap_or(ptr::null_mut())
}

#[cfg(all(test, target_arch = "x86_64"))]
mod tests {
    use super::*;
    #[test]
    fn sdk_dll_validation_pins_bytes_and_rejects_unregistered_dependencies() {
        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let scratch = Scratch(std::env::temp_dir().join(format!(
            "bun-video-dll-validator-{}-{stamp}",
            std::process::id()
        )));
        std::fs::create_dir_all(scratch.0.join("bin")).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
        let descriptor = &manifest["targets"]["windows-x64"]["ffmpeg"];
        let bytes = b"private fixture; never loaded as a DLL";
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut files = serde_json::Map::new();
        for name in names() {
            std::fs::write(scratch.0.join("bin").join(&name), bytes).unwrap();
            files.insert(
                format!("bin/{name}"),
                serde_json::Value::String(hash.clone()),
            );
        }
        let receipt = serde_json::json!({"schema":1,"component":"ffmpeg","target":"windows-x64","version":descriptor["version"],"sourceRevision":descriptor["sourceRevision"],"files":files});
        std::fs::write(
            scratch.0.join("bun-sdk-receipt.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        let slashed = PathBuf::from(scratch.0.to_string_lossy().replace('\\', "/"));
        let verified = verified_dlls(&slashed).unwrap();
        assert_eq!(verified.len(), 4);
        let canonical_prefix = scratch.0.canonicalize().unwrap();
        assert!(
            verified
                .iter()
                .all(|dll| dll.path.starts_with(&canonical_prefix)
                    && !dll.path.to_string_lossy().contains('/'))
        );
        let path = scratch.0.join("bin").join(&names()[0]);
        assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
        drop(verified);
        std::fs::write(&path, b"changed").unwrap();
        assert!(
            verified_dlls(&scratch.0)
                .err()
                .unwrap()
                .contains("hash differs")
        );
        std::fs::write(&path, bytes).unwrap();
        std::fs::write(scratch.0.join("bin/unregistered.dll"), bytes).unwrap();
        assert!(
            verified_dlls(&scratch.0)
                .err()
                .unwrap()
                .contains("unregistered")
        );
    }
}

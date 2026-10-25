use std::{
    env,
    path::{Path, PathBuf},
};

fn major(prefix: &Path, library: &str) -> u32 {
    let header = prefix.join("include").join(library).join("version_major.h");
    let header = if header.is_file() {
        header
    } else {
        prefix.join("include").join(library).join("version.h")
    };
    println!("cargo:rerun-if-changed={}", header.display());
    let text =
        std::fs::read_to_string(&header).expect("qualified FFmpeg SDK version header is required");
    let macro_name = format!("{}_VERSION_MAJOR", library.to_ascii_uppercase());
    text.lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            if words.next() == Some("#define") && words.next() == Some(macro_name.as_str()) {
                words.next()?.parse().ok()
            } else {
                None
            }
        })
        .expect("FFmpeg SDK major version must be a literal integer")
}

fn main() {
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    if env::var_os("CARGO_FEATURE_LIBAV").is_none() {
        return;
    }
    let prefix = PathBuf::from(env::var_os("FFMPEG_DIR").expect(
        "libav requires an explicit qualified FFMPEG_DIR; system discovery is not a provider",
    ));
    assert!(
        prefix.is_absolute() && prefix.join("lib").is_dir(),
        "FFMPEG_DIR must be an absolute qualified SDK prefix"
    );
    let receipt = prefix.join("bun-sdk-receipt.json");
    println!("cargo:rerun-if-changed={}", receipt.display());
    assert!(
        receipt.is_file(),
        "qualify the SDK through its owner before compiling libav"
    );
    for library in ["libavcodec", "libavformat", "libavutil", "libswscale"] {
        let version = major(&prefix, library);
        println!(
            "cargo:rustc-env=BUN_VIDEO_{}_MAJOR={}",
            library.to_ascii_uppercase(),
            version
        );
        if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
            println!(
                "cargo:rustc-link-arg=/DELAYLOAD:{}-{version}.dll",
                library.trim_start_matches("lib")
            );
        }
    }
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=delayimp");
    }
}

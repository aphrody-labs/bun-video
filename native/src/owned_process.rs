use std::io;
use std::ops::{Deref, DerefMut};
use std::process::{Child, Command, Output};

pub struct OwnedChild {
    child: Option<Child>,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

impl Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        self.child.as_ref().expect("live owned child")
    }
}
impl DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        self.child.as_mut().expect("live owned child")
    }
}
impl OwnedChild {
    pub fn wait_with_output(mut self) -> io::Result<Output> {
        self.child
            .take()
            .expect("live owned child")
            .wait_with_output()
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn spawn_owned(command: &mut Command) -> io::Result<OwnedChild> {
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::os::windows::process::{CommandExt, ProcThreadAttributeList};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        use windows_sys::Win32::System::Threading::{
            CREATE_NO_WINDOW, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        };
        // SAFETY: null attributes make the unnamed job handle non-inheritable.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful CreateJobObjectW returns a unique owned handle.
        let job = unsafe { OwnedHandle::from_raw_handle(handle) };
        // SAFETY: this Win32 aggregate contains only integers and nested integer
        // aggregates; all-zero is the documented empty limits initialization.
        let mut limits = unsafe {
            std::mem::MaybeUninit::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>::zeroed().assume_init()
        };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: handle is live; pointer and size name the exact required structure.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let handles = [job.as_raw_handle()];
        let attributes = ProcThreadAttributeList::build()
            .attribute(PROC_THREAD_ATTRIBUTE_JOB_LIST as usize, &handles)
            .finish()?;
        // Job assignment is atomic with process creation, before user code can fork.
        let child = command
            .creation_flags(CREATE_NO_WINDOW)
            .spawn_with_attributes(&attributes)?;
        Ok(OwnedChild {
            child: Some(child),
            _job: job,
        })
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: getpid has no pointer arguments and cannot fail.
        let parent = unsafe { libc::getpid() };
        // SAFETY: this closure only invokes async-signal-safe syscalls after fork.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    return Err(io::Error::other(
                        "media parent exited before child ownership was established",
                    ));
                }
                Ok(())
            });
        }
    }
    #[cfg(not(windows))]
    Ok(OwnedChild {
        child: Some(command.spawn()?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires qualified FFmpeg; integration verifies running process teardown"]
    fn dropping_owned_media_child_reaps_waiting_encoder() {
        use std::process::Stdio;
        let ffmpeg = std::env::var_os("BUN_VIDEO_FFMPEG").expect("set qualified FFmpeg path");
        let mut child = spawn_owned(
            Command::new(ffmpeg)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "image2pipe",
                    "-vcodec",
                    "png",
                    "-i",
                    "pipe:0",
                    "-f",
                    "null",
                    "-",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit()),
        )
        .expect("spawn waiting encoder");
        assert!(child.try_wait().expect("child status").is_none());
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
            };
            // SAFETY: child PID names our live child; handle requests synchronization only.
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, child.id()) };
            assert!(!handle.is_null());
            // SAFETY: OpenProcess returned a unique handle whose ownership is transferred.
            let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
            drop(child);
            // SAFETY: owned handle remains valid until after the bounded wait.
            assert_eq!(
                unsafe { WaitForSingleObject(handle.as_raw_handle(), 1000) },
                WAIT_OBJECT_0
            );
        }
        #[cfg(target_os = "linux")]
        {
            let pid = child.id() as libc::pid_t;
            drop(child);
            // SAFETY: kill with signal zero checks existence without signaling a process.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess fixture; invoked only by abrupt-parent integration test"]
    fn fixture_leaf() {
        if std::env::var_os("BUN_VIDEO_OWNER_FIXTURE").is_none() {
            return;
        }
        loop {
            std::thread::park();
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess fixture; invoked only by abrupt-parent integration test"]
    fn fixture_owner() {
        use std::io::Write;
        use std::process::Stdio;
        if std::env::var_os("BUN_VIDEO_OWNER_FIXTURE").is_none() {
            return;
        }
        let leaf = spawn_owned(
            Command::new(std::env::current_exe().expect("test binary"))
                .args([
                    "--exact",
                    "owned_process::tests::fixture_leaf",
                    "--ignored",
                    "--nocapture",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit()),
        )
        .expect("owned leaf");
        println!("OWNED_LEAF_PID={}", leaf.id());
        io::stdout().flush().expect("flush child PID");
        loop {
            std::thread::park();
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "real Windows abrupt-parent teardown integration"]
    fn abrupt_parent_death_kills_owned_leaf() {
        use std::io::BufRead;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use std::process::Stdio;
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess,
            WaitForSingleObject,
        };
        // The outer parent is intentionally not job-owned: only its own leaf
        // job can enforce sudden-parent teardown, so this test cannot self-mask.
        let mut parent = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--exact",
                "owned_process::tests::fixture_owner",
                "--ignored",
                "--nocapture",
            ])
            .env("BUN_VIDEO_OWNER_FIXTURE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn abrupt parent");
        let mut pid = None;
        for line in io::BufReader::new(parent.stdout.take().expect("parent stdout")).lines() {
            let line = line.expect("parent line");
            if let Some(value) = line.strip_prefix("OWNED_LEAF_PID=") {
                pid = Some(value.parse::<u32>().expect("leaf PID"));
                break;
            }
        }
        let Some(pid) = pid else {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("parent fixture did not announce leaf");
        };
        // SAFETY: announced PID identifies our live fixture; retain a handle to
        // prevent PID reuse and reserve termination only for failure cleanup.
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
        if raw.is_null() {
            let _ = parent.kill();
            let _ = parent.wait();
            panic!("cannot retain leaf process handle");
        }
        // SAFETY: successful OpenProcess returns a uniquely owned live handle.
        let leaf = unsafe { OwnedHandle::from_raw_handle(raw) };
        parent.kill().expect("abruptly kill parent");
        parent.wait().expect("reap parent");
        // SAFETY: retained owned handle is valid for the bounded process wait.
        let result = unsafe { WaitForSingleObject(leaf.as_raw_handle(), 1000) };
        if result != WAIT_OBJECT_0 {
            // SAFETY: cleanup targets only the retained test leaf handle.
            unsafe {
                TerminateProcess(leaf.as_raw_handle(), 1);
                WaitForSingleObject(leaf.as_raw_handle(), 1000);
            }
        }
        assert_eq!(
            result, WAIT_OBJECT_0,
            "owned leaf survived sudden Rust parent death"
        );
    }
}

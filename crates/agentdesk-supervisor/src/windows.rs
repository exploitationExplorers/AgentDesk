use std::{
    io,
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::Child,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{CreateMutexW, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
    },
};

pub struct Job(OwnedHandle);

impl Job {
    pub fn new() -> io::Result<Self> {
        // 空 SECURITY_ATTRIBUTES 表示句柄不继承，子进程不能延长 Job 生命周期。
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }

    pub fn assign_and_resume(&self, child: &Child) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // Command 不暴露 CreateProcessW 返回的初始线程句柄。进程仍暂停且尚未运行，
        // 因此按已持有的 Child 身份找到唯一初始线程，再取得句柄恢复，避免先运行后入组。
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == child.id() {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "找不到暂停进程的初始线程",
        ))
    }

    pub fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub struct InstanceLock {
    _handle: OwnedHandle,
}

impl InstanceLock {
    pub fn for_directory(directory: &std::path::Path) -> io::Result<Self> {
        use std::hash::{DefaultHasher, Hash, Hasher};
        std::fs::create_dir_all(directory)?;
        let mut hasher = DefaultHasher::new();
        directory
            .canonicalize()?
            .to_string_lossy()
            .to_lowercase()
            .hash(&mut hasher);
        Self::acquire(&format!("{:x}", hasher.finish()))
    }

    pub fn acquire(name: &str) -> io::Result<Self> {
        let wide: Vec<u16> = format!("Local\\AgentDesk.{name}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let handle: HANDLE = unsafe { CreateMutexW(null(), 0, wide.as_ptr()) };
        if handle == null_mut() {
            return Err(io::Error::last_os_error());
        }
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        if already_exists {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "AgentDesk 宿主已经启动",
            ));
        }
        Ok(Self { _handle: owned })
    }
}

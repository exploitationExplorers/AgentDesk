use std::{
    io,
    process::{Child, Command},
    time::Duration,
};

#[cfg(windows)]
mod windows;

/// Job 持有期间只管理本应用创建的进程，关闭最后一个句柄会清理整棵树。
pub struct ManagedChild {
    pub child: Child,
    #[cfg(windows)]
    job: windows::Job,
}

impl ManagedChild {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // std::Command 在 Windows 内部使用 CreateProcessW；新进程在任何用户代码前暂停。
            command.creation_flags(0x0000_0004 | 0x0800_0000);
            let job = windows::Job::new()?;
            let mut child = command.spawn()?;
            if let Err(error) = job.assign_and_resume(&child) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child: command.spawn()?,
            })
        }
    }

    pub fn stop(&mut self, grace: Duration) -> io::Result<()> {
        drop(self.child.stdin.take());
        let deadline = std::time::Instant::now() + grace;
        while std::time::Instant::now() < deadline {
            if self.child.try_wait()?.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        #[cfg(windows)]
        self.job.terminate()?;
        #[cfg(not(windows))]
        if self.child.try_wait()?.is_none() {
            self.child.kill()?;
        }
        self.child.wait()?;
        Ok(())
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.stop(Duration::from_millis(0));
    }
}

#[cfg(windows)]
pub use windows::InstanceLock;

use agentdesk_supervisor::ManagedChild;
use std::{
    env,
    ffi::OsString,
    io::{self, Read},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};

fn main() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let mut daemon = false;
    let mut directory: Option<OsString> = None;
    let program = loop {
        let argument = args
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "缺少受管程序"))?;
        if argument == "--daemon" {
            daemon = true;
        } else if argument == "--instance-data-dir" {
            directory =
                Some(args.next().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "缺少实例数据目录")
                })?);
        } else {
            break argument;
        }
    };
    #[cfg(windows)]
    let _instance = directory
        .as_ref()
        .map(|path| agentdesk_supervisor::InstanceLock::for_directory(std::path::Path::new(path)))
        .transpose()?;
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(if daemon {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut child = ManagedChild::spawn(&mut command)?;
    let input = child.child.stdin.take();
    let (closed_tx, closed_rx) = mpsc::channel();
    if !daemon {
        thread::spawn(move || {
            if let Some(mut target) = input {
                let _ = io::copy(&mut io::stdin(), &mut target);
            } else {
                let mut byte = [0];
                let _ = io::stdin().read(&mut byte);
            }
            let _ = closed_tx.send(());
        });
    }
    loop {
        if let Some(status) = child.child.try_wait()? {
            child.stop(Duration::ZERO)?;
            std::process::exit(status.code().unwrap_or(1));
        }
        if closed_rx.try_recv().is_ok() {
            child.stop(Duration::from_secs(3))?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

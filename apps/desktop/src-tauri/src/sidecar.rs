use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

#[cfg(windows)]
use agentdesk_supervisor::InstanceLock;
use agentdesk_supervisor::ManagedChild;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
pub struct SidecarInfo {
    pub url: String,
    pub token: String,
}

#[derive(Default)]
pub struct SidecarState {
    pub info: Arc<Mutex<Option<SidecarInfo>>>,
    pub child: Mutex<Option<ManagedChild>>,
    pub error: Arc<Mutex<Option<String>>>,
    #[cfg(windows)]
    pub instance: Mutex<Option<InstanceLock>>,
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(17890)
}

/// 开发模式直接用 tsx 运行源码；发布版使用安装包内置的 node.exe 和打包后的 index.mjs。
fn command(app: &AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecar");
        let mut cmd = Command::new("node");
        cmd.args(["--import", "tsx", "src/index.ts"])
            .current_dir(dir);
        Ok(cmd)
    } else {
        let dir = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("sidecar");
        let mut cmd = Command::new(dir.join("node.exe"));
        cmd.arg(dir.join("index.mjs"))
            .env("AGENTDESK_SKILLS_DIR", dir.join("skills"))
            .current_dir(&dir);
        Ok(cmd)
    }
}

pub fn spawn(app: &AppHandle, state: &SidecarState) -> Result<(), String> {
    #[cfg(windows)]
    {
        let directory = std::env::var_os("AGENTDESK_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("AgentDesk")
            });
        *state.instance.lock().unwrap() = Some(
            InstanceLock::for_directory(&directory).map_err(|e| e.to_string())?,
        );
    }
    let token = crate::secrets::random_token()?;
    let master_key = crate::secrets::master_key().unwrap_or_else(|e| {
        eprintln!("[agentdesk] 无法访问系统钥匙串，sidecar 将使用本地密钥文件: {e}");
        String::new()
    });
    let port = free_port();

    let mut cmd = command(app)?;
    cmd.env("AGENTDESK_TOKEN", &token)
        .env("AGENTDESK_PORT", port.to_string())
        .env("AGENTDESK_PARENT_STDIN", "1")
        .env("AGENTDESK_VERSION", app.package_info().version.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !master_key.is_empty() {
        cmd.env("AGENTDESK_MASTER_KEY", master_key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = ManagedChild::spawn(&mut cmd).map_err(|e| format!("启动 sidecar 失败: {e}"))?;
    let stdout = child.child.stdout.take();
    let stderr = child.child.stderr.take();

    let info = state.info.clone();
    if let Some(out) = stdout {
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(p) = line.strip_prefix("AGENTDESK_READY port=") {
                    let port = p.trim().parse::<u16>().unwrap_or(port);
                    *info.lock().unwrap() = Some(SidecarInfo {
                        url: format!("http://127.0.0.1:{port}"),
                        token: token.clone(),
                    });
                }
                println!("[sidecar] {line}");
            }
        });
    }
    let error = state.error.clone();
    if let Some(err) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                eprintln!("[sidecar] {line}");
                if line.contains("failed to start") {
                    *error.lock().unwrap() = Some(line);
                }
            }
        });
    }

    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

pub fn kill(state: &SidecarState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        // 先协作退出，再结束 Job 内全部子孙进程，包括 Hub 和任务工具。
        let _ = child.stop(std::time::Duration::from_secs(3));
    }
}

#![cfg(windows)]
use agentdesk_supervisor::{InstanceLock, ManagedChild};
use std::{
    io::{BufRead, BufReader},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::{Command, Stdio},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::Threading::{OpenProcess, WaitForSingleObject, SYNCHRONIZATION_SYNCHRONIZE},
};

#[test]
fn suspended_spawn_owns_parent_children_and_grandchildren() {
    let script = "const {spawn}=require('node:child_process'); console.log(process.pid); spawn(process.execPath,['-e',\"const {spawn}=require('node:child_process'); console.log(process.pid); spawn(process.execPath,['-e','console.log(process.pid); setTimeout(()=>{},30000)'],{stdio:'inherit'}); setTimeout(()=>{},30000)\"],{stdio:'inherit'}); setTimeout(()=>{},30000)";
    let mut command = Command::new("node");
    command
        .args(["-e", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut managed = ManagedChild::spawn(&mut command).expect("受管启动");
    let mut output = BufReader::new(managed.child.stdout.take().unwrap());
    let mut handles = Vec::new();
    for _ in 0..3 {
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let pid = line.trim().parse::<u32>().unwrap();
        let handle = unsafe { OpenProcess(SYNCHRONIZATION_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null());
        handles.push(unsafe { OwnedHandle::from_raw_handle(handle) });
    }
    managed.stop(Duration::from_millis(30)).expect("停止进程树");
    for process in handles {
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 3000) },
            WAIT_OBJECT_0
        );
    }
}

#[test]
fn instance_mutex_is_exclusive_until_owner_drops() {
    let name = format!("test-{}", std::process::id());
    let first = InstanceLock::acquire(&name).unwrap();
    assert!(InstanceLock::acquire(&name).is_err());
    drop(first);
    assert!(InstanceLock::acquire(&name).is_ok());
}

#[test]
fn supervisor_crash_closes_job_without_touching_other_processes() {
    let mut unrelated = Command::new("node")
        .args(["-e", "setTimeout(()=>{},30000)"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut supervisor = Command::new(env!("CARGO_BIN_EXE_agentdesk-supervisor"));
    supervisor
        .args([
            "node",
            "-e",
            "console.log(process.pid);setTimeout(()=>{},30000)",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    let mut supervisor = supervisor.spawn().unwrap();
    let mut output = BufReader::new(supervisor.stdout.take().unwrap());
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let process = unsafe {
        OpenProcess(
            SYNCHRONIZATION_SYNCHRONIZE,
            0,
            line.trim().parse::<u32>().unwrap(),
        )
    };
    assert!(!process.is_null());
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    supervisor.kill().unwrap();
    supervisor.wait().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 3000) },
        WAIT_OBJECT_0
    );
    assert!(unrelated.try_wait().unwrap().is_none());
    unrelated.kill().unwrap();
    unrelated.wait().unwrap();
}

//! Killing a process group, the same way on Linux and macOS (the `kill` command does not take
//! the same arguments everywhere).

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

const SIGKILL: i32 = 9;

/// SIGKILL to every process of the group led by `pid` (spawned with `process_group(0)`).
pub fn kill_group(pid: u32) {
    let Ok(pid) = i32::try_from(pid) else { return };
    if pid <= 1 {
        return;
    }
    // SAFETY: kill(2) only reads its arguments; a negative pid names the process group.
    unsafe {
        kill(-pid, SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[test]
    fn kills_the_whole_group() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30 & sleep 30"])
            .process_group(0)
            .spawn()
            .unwrap();
        super::kill_group(child.id());
        let status = child.wait().unwrap();
        assert!(!status.success());
    }
}

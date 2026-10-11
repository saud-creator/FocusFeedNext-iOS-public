//! AgentReachManager.
//!
//! Agent Reach is used for installation, health checks, diagnostics and backend
//! discovery — NOT for serving feed requests. Results are cached so a doctor run
//! never happens on the hot path of loading posts.

use crate::models::*;
use crate::security;
use chrono::Utc;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct AgentReachManager {
    bin: Option<PathBuf>,
    cache: Mutex<Option<(HealthReport, Instant)>>,
    ttl: Duration,
}

impl Default for AgentReachManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentReachManager {
    pub fn new() -> Self {
        Self {
            bin: locate(),
            cache: Mutex::new(None),
            ttl: Duration::from_secs(300),
        }
    }

    pub fn is_installed(&self) -> bool {
        self.bin.is_some()
    }

    pub fn binary_path(&self) -> Option<String> {
        self.bin.as_ref().map(|p| p.display().to_string())
    }

    pub fn version(&self) -> Option<String> {
        let (out, _, _) = run(
            self.bin.as_ref()?,
            &["--version".into()],
            Duration::from_secs(20),
        )
        .ok()?;
        Some(out.trim().to_string())
    }

    /// Cached health. Pass `force` to bypass the cache (explicit user refresh,
    /// startup, or a post-update verification).
    pub fn health(&self, force: bool) -> HealthReport {
        if !force {
            if let Ok(guard) = self.cache.lock() {
                if let Some((report, at)) = guard.as_ref() {
                    if at.elapsed() < self.ttl {
                        return report.clone();
                    }
                }
            }
        }
        let report = self.run_doctor();
        if let Ok(mut guard) = self.cache.lock() {
            *guard = Some((report.clone(), Instant::now()));
        }
        report
    }

    fn run_doctor(&self) -> HealthReport {
        let now = Utc::now().to_rfc3339();
        let Some(bin) = self.bin.as_ref() else {
            return HealthReport {
                agent_reach_installed: false,
                agent_reach_version: None,
                channels: vec![],
                twitter_status: None,
                checked_at: now,
                error: Some("Agent Reach is not installed.".into()),
            };
        };

        match run(
            bin,
            &["doctor".into(), "--json".into()],
            Duration::from_secs(90),
        ) {
            Ok((stdout, stderr, _)) => {
                let start = stdout.find('{');
                let parsed = start.and_then(|s| serde_json::from_str::<Value>(&stdout[s..]).ok());
                match parsed {
                    Some(Value::Object(map)) => {
                        let mut channels: Vec<ChannelHealth> = map
                            .iter()
                            .map(|(key, v)| ChannelHealth {
                                key: key.clone(),
                                name: v
                                    .get("name")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or(key)
                                    .to_string(),
                                status: v
                                    .get("status")
                                    .and_then(|x| x.as_str())
                                    .unwrap_or("unknown")
                                    .to_string(),
                                message: security::sanitize(
                                    v.get("message").and_then(|x| x.as_str()).unwrap_or(""),
                                ),
                                tier: v.get("tier").and_then(|x| x.as_i64()).unwrap_or(0),
                                backends: v
                                    .get("backends")
                                    .and_then(|x| x.as_array())
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|b| b.as_str().map(String::from))
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                active_backend: v
                                    .get("active_backend")
                                    .and_then(|x| x.as_str())
                                    .map(String::from),
                            })
                            .collect();
                        channels.sort_by(|a, b| a.key.cmp(&b.key));
                        let twitter_status = channels
                            .iter()
                            .find(|c| c.key == "twitter")
                            .map(|c| c.status.clone());
                        HealthReport {
                            agent_reach_installed: true,
                            agent_reach_version: self.version(),
                            channels,
                            twitter_status,
                            checked_at: now,
                            error: None,
                        }
                    }
                    _ => HealthReport {
                        agent_reach_installed: true,
                        agent_reach_version: self.version(),
                        channels: vec![],
                        twitter_status: None,
                        checked_at: now,
                        error: Some(security::sanitize(&format!(
                            "doctor output could not be parsed: {}",
                            stderr.trim()
                        ))),
                    },
                }
            }
            Err(e) => HealthReport {
                agent_reach_installed: true,
                agent_reach_version: None,
                channels: vec![],
                twitter_status: None,
                checked_at: now,
                error: Some(security::sanitize(&e)),
            },
        }
    }

    /// Read the cached report without ever running `doctor`.
    ///
    /// `doctor` probes every channel, several over the network, so it can take
    /// a minute. Anything on a hot UI path (the Home dashboard) must use this
    /// and treat `None` as "not checked yet" rather than blocking.
    pub fn cached_health(&self) -> Option<HealthReport> {
        self.cache
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|(r, _)| r.clone()))
    }

    /// The X backend Agent Reach currently considers active, if any.
    pub fn active_x_backend(&self) -> Option<String> {
        self.health(false)
            .channels
            .into_iter()
            .find(|c| c.key == "twitter")
            .and_then(|c| c.active_backend)
    }
}

fn locate() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("FFN_AGENT_REACH") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) {
        "agent-reach.exe"
    } else {
        "agent-reach"
    };
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let c = dir.join(name);
            if c.is_file() {
                return Some(c);
            }
        }
    }
    // The venv the project installed it into.
    if let Some(home) = dirs::home_dir() {
        for rel in [
            [".agent-reach-venv", "Scripts", name].join(std::path::MAIN_SEPARATOR_STR),
            [".agent-reach-venv", "bin", name].join(std::path::MAIN_SEPARATOR_STR),
            [".local", "bin", name].join(std::path::MAIN_SEPARATOR_STR),
        ] {
            let c = home.join(rel);
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

/// Run a process with a hard timeout, draining both pipes concurrently.
fn run(
    bin: &PathBuf,
    args: &[String],
    timeout: Duration,
) -> Result<(String, String, bool), String> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let h1 = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(p) = so.as_mut() {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let h2 = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(p) = se.as_mut() {
            let _ = p.read_to_string(&mut s);
        }
        s
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("process error: {e}")),
        }
    };
    Ok((
        h1.join().unwrap_or_default(),
        h2.join().unwrap_or_default(),
        status.success(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCTOR: &str = r#"{
      "twitter": {"status":"warn","name":"Twitter/X","message":"installed but not authenticated",
        "tier":1,"backends":["twitter-cli","OpenCLI"],"active_backend":"twitter-cli"},
      "web": {"status":"ok","name":"Web","message":"reader available","tier":0,
        "backends":["Jina"],"active_backend":"Jina"}
    }"#;

    fn parse(raw: &str) -> Vec<ChannelHealth> {
        let v: Value = serde_json::from_str(raw).unwrap();
        let map = v.as_object().unwrap();
        let mut out: Vec<ChannelHealth> = map
            .iter()
            .map(|(key, v)| ChannelHealth {
                key: key.clone(),
                name: v.get("name").and_then(|x| x.as_str()).unwrap_or(key).into(),
                status: v
                    .get("status")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unknown")
                    .into(),
                message: security::sanitize(
                    v.get("message").and_then(|x| x.as_str()).unwrap_or(""),
                ),
                tier: v.get("tier").and_then(|x| x.as_i64()).unwrap_or(0),
                backends: v
                    .get("backends")
                    .and_then(|x| x.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|b| b.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                active_backend: v
                    .get("active_backend")
                    .and_then(|x| x.as_str())
                    .map(String::from),
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    #[test]
    fn parses_the_doctor_report() {
        let channels = parse(DOCTOR);
        assert_eq!(channels.len(), 2);
        let tw = channels.iter().find(|c| c.key == "twitter").unwrap();
        assert_eq!(tw.status, "warn");
        assert_eq!(tw.active_backend.as_deref(), Some("twitter-cli"));
        assert_eq!(tw.backends.len(), 2);
    }

    #[test]
    fn doctor_messages_are_sanitized() {
        let raw = r#"{"twitter":{"status":"warn","name":"X","message":"auth_token=leaky ct0=alsoleaky"}}"#;
        let channels = parse(raw);
        assert!(
            !channels[0].message.contains("leaky"),
            "{}",
            channels[0].message
        );
    }

    #[test]
    fn missing_binary_reports_not_installed() {
        let m = AgentReachManager {
            bin: None,
            cache: Mutex::new(None),
            ttl: Duration::from_secs(1),
        };
        let h = m.health(true);
        assert!(!h.agent_reach_installed);
        assert!(h.error.is_some());
        assert!(h.channels.is_empty());
    }

    #[test]
    fn health_is_cached_between_calls() {
        let m = AgentReachManager {
            bin: None,
            cache: Mutex::new(None),
            ttl: Duration::from_secs(300),
        };
        let a = m.health(true);
        let b = m.health(false);
        assert_eq!(
            a.checked_at, b.checked_at,
            "second call should hit the cache"
        );
    }
}

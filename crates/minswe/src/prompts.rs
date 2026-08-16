//! Embedded prompt/observation/format templates + minijinja rendering.
//!
//! The four `.j2` files in `templates/` are verbatim copies of
//! `src/minisweagent/config/default.yaml`'s templates (tracked with an
//! upstream-commit note in the crate README). They render unchanged through
//! `minijinja` (Jinja2-compatible), including the macOS `sed -i ''` branch
//! (`{%- if system == "Darwin" -%}`) and the `output.output[:5000]` slicing
//! in the observation template.

use minijinja::{context, Environment, Value};

const SYSTEM_TEMPLATE: &str = include_str!("../templates/system.j2");
const INSTANCE_TEMPLATE: &str = include_str!("../templates/instance.j2");
const OBSERVATION_TEMPLATE: &str = include_str!("../templates/observation.j2");
const FORMAT_ERROR_TEMPLATE: &str = include_str!("../templates/format_error.j2");

/// System info for the instance template, mirroring `platform.uname()`:
/// `(system, release, version, machine)`. On Windows the values come from the
/// registry/`ver`; on Unix from `uname -a`.
#[derive(Debug, Clone)]
pub struct SystemInfo {
    pub system: String,
    pub release: String,
    pub version: String,
    pub machine: String,
}

impl SystemInfo {
    pub fn detect() -> Self {
        // mini-swe-agent uses Python's platform.uname(). We approximate it
        // without pulling in a crate: the fields only flow into the prompt's
        // <system_information> block and the macOS sed branch.
        #[cfg(unix)]
        {
            #[cfg(target_os = "macos")]
            let sys = "Darwin";
            #[cfg(target_os = "linux")]
            let sys = "Linux";
            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            let sys = std::ffi::OsStr::new(std::env::consts::OS).to_string_lossy().into_owned();
            let (release, version, machine) = uname().unwrap_or_default();
            Self {
                system: sys.to_string(),
                release,
                version,
                machine,
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                system: "Windows".into(),
                release: String::new(),
                version: String::new(),
                machine: std::env::consts::ARCH.into(),
            }
        }
    }
}

#[cfg(unix)]
fn uname() -> Option<(String, String, String)> {
    // SAFETY: uname writes into a zero-initialized utsname; the fields are
    // NUL-terminated C strings. This matches libc's documented contract.
    use std::ffi::CStr;
    use std::mem::MaybeUninit;
    unsafe {
        let mut buf: MaybeUninit<libc::utsname> = MaybeUninit::zeroed();
        if libc::uname(buf.as_mut_ptr()) != 0 {
            return None;
        }
        let buf = buf.assume_init();
        let to_string = |c: &[libc::c_char]| {
            // SAFETY: `c` is a NUL-terminated utsname field of `c.len()`
            // one-byte c_chars; reinterpreting it as `u8` is valid on every
            // cfg(unix) target, and `from_bytes_until_nul` stops at the first
            // NUL byte.
            let bytes = unsafe { std::slice::from_raw_parts(c.as_ptr().cast::<u8>(), c.len()) };
            CStr::from_bytes_until_nul(bytes)
                .ok()?
                .to_string_lossy()
                .into_owned()
        };
        Some((
            to_string(&buf.release),
            to_string(&buf.version),
            to_string(&buf.machine),
        ))
    }
}

fn env() -> Environment<'static> {
    Environment::new()
}

/// Render the system message (the first message in the history).
pub fn render_system() -> String {
    let env = env();
    env.render_str(SYSTEM_TEMPLATE, ()).expect("system template")
}

/// Render the instance (first user) message. `task` is the run prompt;
/// `info` supplies the `<system_information>` block.
pub fn render_instance(task: &str, info: &SystemInfo) -> String {
    let env = env();
    env.render_str(
        INSTANCE_TEMPLATE,
        context! {
            task,
            system => &info.system,
            release => &info.release,
            version => &info.version,
            machine => &info.machine,
        },
    )
    .expect("instance template")
}

/// Render an observation for one executed action. Matches mini's
/// `observation_template`: under 10000 chars the full output is shown; above,
/// a 5000-char head and 5000-char tail with a "characters elided" count.
pub fn render_observation(output: &crate::EnvOutput) -> String {
    let env = env();
    let output_val = context! {
        output => output.output,
        returncode => output.returncode,
        exception_info => output.exception_info,
    };
    env.render_str(OBSERVATION_TEMPLATE, Value::from_iter([("output", output_val)]))
        .expect("observation template")
}

/// Render the format-error feedback shown when the model returns no valid bash
/// action. `finish_reason` (e.g. `"length"` / `"tool_calls"`) selects the
/// truncation-focused message; `error` is the human-readable cause.
pub fn render_format_error(error: &str, finish_reason: Option<&str>, n_actions: usize) -> String {
    let env = env();
    let actions_val = minijinja::value::Value::from(
        (0..n_actions).map(|_| minijinja::value::Value::UNDEFINED).collect::<Vec<_>>(),
    );
    env.render_str(
        FORMAT_ERROR_TEMPLATE,
        context! {
            error,
            actions => actions_val,
            finish_reason => finish_reason,
        },
    )
    .expect("format-error template")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_renders() {
        let s = render_system();
        assert!(s.contains("mswea_bash_command"));
        assert!(s.contains("format_example"));
    }

    #[test]
    fn instance_renders_macos_sed_branch() {
        let mac = SystemInfo {
            system: "Darwin".into(),
            release: "23.0".into(),
            version: "Darwin Kernel".into(),
            machine: "arm64".into(),
        };
        let out = render_instance("fix the bug", &mac);
        assert!(out.contains("You are on MacOS"));
        assert!(out.contains("sed -i ''"));
        assert!(out.contains("fix the bug"));
        assert!(out.contains("Darwin 23.0"));
    }

    #[test]
    fn instance_renders_no_macos_branch_on_linux() {
        let linux = SystemInfo {
            system: "Linux".into(),
            release: "6.6".into(),
            version: "#1".into(),
            machine: "x86_64".into(),
        };
        let out = render_instance("fix the bug", &linux);
        assert!(!out.contains("You are on MacOS"));
        assert!(out.contains("Linux 6.6"));
    }

    #[test]
    fn observation_short_output_inlined() {
        let out = crate::EnvOutput {
            output: "hello world".into(),
            returncode: 0,
            exception_info: String::new(),
        };
        let rendered = render_observation(&out);
        assert!(rendered.contains("<returncode>0</returncode>"));
        assert!(rendered.contains("hello world"));
        assert!(!rendered.contains("characters elided"));
    }

    #[test]
    fn observation_long_output_head_tail_elided() {
        let big = "x".repeat(20_000);
        let out = crate::EnvOutput {
            output: big,
            returncode: 0,
            exception_info: String::new(),
        };
        let rendered = render_observation(&out);
        assert!(rendered.contains("too long"));
        assert!(rendered.contains("10000 characters elided"));
        assert!(rendered.contains("<output_head>"));
        assert!(rendered.contains("<output_tail>"));
    }

    #[test]
    fn observation_exception_included() {
        let out = crate::EnvOutput {
            output: String::new(),
            returncode: -1,
            exception_info: "boom".into(),
        };
        let rendered = render_observation(&out);
        assert!(rendered.contains("<exception>boom</exception>"));
        assert!(rendered.contains("<returncode>-1</returncode>"));
    }

    #[test]
    fn format_error_with_length_finish_reason() {
        let rendered = render_format_error("ignored", Some("length"), 0);
        assert!(rendered.contains("output token limit"));
        assert!(rendered.contains("finish_reason=length"));
    }

    #[test]
    fn format_error_generic_counts_actions() {
        let rendered = render_format_error("No tool calls found", None, 0);
        assert!(rendered.contains("Format error:"));
        assert!(rendered.contains("No tool calls found"));
        assert!(rendered.contains("found 0 actions"));
    }

    #[test]
    fn detect_system_info_runs() {
        let info = SystemInfo::detect();
        assert!(!info.system.is_empty());
    }
}

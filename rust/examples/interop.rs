//! Test-only JSON bridge. It is not installed or shipped as a product command.
use hraness_support_foundation::{
    maybe_show_with_output, run_support_command, Audience, Options, Output, SupportProfile,
};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    profile: SupportProfile,
    #[serde(default)]
    args: Vec<String>,
    command: Vec<String>,
    state_directory: PathBuf,
    env: BTreeMap<String, String>,
    now: u64,
    audience: Option<Audience>,
    cwd: Option<PathBuf>,
    git_email: Option<bool>,
    hook: Option<bool>,
    is_tty: Option<bool>,
    stderr_is_tty: Option<bool>,
    fail_output: Option<bool>,
    delay_output: Option<u64>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().take(65537).read_to_string(&mut input)?;
    if input.len() > 65536 {
        return Err("oversized test request".into());
    }
    let request: Request = serde_json::from_str(&input)?;
    let options = Options {
        command: request.command,
        audience: request.audience,
        stderr_is_terminal: Some(request.stderr_is_tty.unwrap_or(false)),
        state_directory: Some(request.state_directory),
        env: Some(request.env),
        now: Some(request.now),
        cwd: request.cwd,
        git_email: request.git_email,
    };
    let result = if let Some(useful) = request.hook {
        let buffer = Arc::new(Mutex::new(String::new()));
        let written = Arc::clone(&buffer);
        let sink = Output::new(request.is_tty.unwrap_or(false), move |text| {
            if let Some(delay) = request.delay_output {
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
            if request.fail_output == Some(true) {
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            written.lock().expect("test output mutex").push_str(text);
            Ok(())
        });
        let shown = maybe_show_with_output(&request.profile, useful, &options, &sink);
        json!({"shown":shown, "output":buffer.lock().expect("test output mutex").clone()})
    } else {
        serde_json::to_value(run_support_command(
            &request.profile,
            &request.args,
            &options,
        ))?
    };
    writeln!(std::io::stdout(), "{result}")?;
    Ok(())
}

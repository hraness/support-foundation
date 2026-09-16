use crate::{
    audience, create_support_offer, create_support_protocol, duration, env_value, js_trim, now,
    render_offer, schema, state, suppressed, Audience, CommandResult, Options, SupportError,
    SupportProfile,
};
use regex::Regex;
use serde_json::{json, Value};
use std::io::{IsTerminal, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, OnceLock,
};
use std::time::{Duration, Instant};

type Writer = dyn Fn(&str) -> std::io::Result<()> + Send + Sync;

/// A shared output sink. Clones serialize pending writes. A timeout is an
/// uncertain output and never commits a presentation receipt. The writer must
/// report accepted output, not human reading or consent.
#[derive(Clone)]
pub struct Output {
    is_tty: bool,
    writer: Arc<Writer>,
    pending: Arc<AtomicBool>,
}

impl Output {
    pub fn new(
        is_tty: bool,
        writer: impl Fn(&str) -> std::io::Result<()> + Send + Sync + 'static,
    ) -> Self {
        Self {
            is_tty,
            writer: Arc::new(writer),
            pending: Arc::new(AtomicBool::new(false)),
        }
    }

    fn write(&self, text: String) -> bool {
        if self
            .pending
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        let pending = Arc::clone(&self.pending);
        let writer = Arc::clone(&self.writer);
        let (send, receive) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("support-output".into())
            .spawn(move || {
                let result =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| writer(&text)))
                        .is_ok_and(|r| r.is_ok());
                pending.store(false, Ordering::Release);
                let _ = send.send(result);
            });
        if thread.is_err() {
            self.pending.store(false, Ordering::Release);
            return false;
        }
        receive
            .recv_timeout(Duration::from_millis(duration("OUTPUT_TIMEOUT_MS")))
            .unwrap_or(false)
    }
}

fn standard_output() -> &'static Output {
    static OUTPUT: OnceLock<Output> = OnceLock::new();
    OUTPUT.get_or_init(|| {
        Output::new(std::io::stderr().is_terminal(), |text| {
            let mut stderr = std::io::stderr().lock();
            stderr.write_all(text.as_bytes())?;
            stderr.flush()
        })
    })
}

fn success(value: Value) -> CommandResult {
    CommandResult {
        exit_code: 0,
        stdout: format!("{value}\n"),
        stderr: String::new(),
    }
}
fn failure(message: &str, exit_code: i32) -> CommandResult {
    CommandResult {
        exit_code,
        stdout: String::new(),
        stderr: format!("{message}\n"),
    }
}
fn unavailable(error: state::StateError) -> CommandResult {
    failure(
        &format!("Support preferences are unavailable ({}).", error.reason()),
        1,
    )
}

fn email_candidate(text: &str) -> Option<String> {
    static LOCAL: OnceLock<Regex> = OnceLock::new();
    static DOMAIN: OnceLock<Regex> = OnceLock::new();
    static NOREPLY: OnceLock<Regex> = OnceLock::new();
    let candidate = js_trim(text);
    let (local, domain) = candidate.split_once('@')?;
    let domain = domain.to_ascii_lowercase();
    let valid = candidate.len() <= 254 && local.len() <= 64
        && LOCAL.get_or_init(|| Regex::new(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$").expect("constant regex")).is_match(local)
        && !local.starts_with('.') && !local.ends_with('.') && !local.contains("..")
        && DOMAIN.get_or_init(|| Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$").expect("constant regex")).is_match(&domain)
        && domain != "noreply.github.com" && !domain.ends_with(".noreply.github.com")
        && !NOREPLY.get_or_init(|| Regex::new(r"(?i)^(?:no-?reply|do-?not-?reply)$").expect("constant regex")).is_match(local);
    valid.then(|| candidate.to_owned())
}

fn bounded_read(
    reader: impl Read + Send + 'static,
) -> std::io::Result<mpsc::Receiver<Option<Vec<u8>>>> {
    let (send, receive) = mpsc::channel();
    std::thread::Builder::new()
        .name("support-git-read".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let result = reader.take(1025).read_to_end(&mut bytes);
            let _ = send.send(result.ok().filter(|_| bytes.len() <= 1024).map(|_| bytes));
        })?;
    Ok(receive)
}

fn git_email(options: &Options) -> Option<String> {
    let mut command = Command::new("git");
    command
        .args(["config", "--get", "user.email"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        command.env_clear().envs(env);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut child = command.spawn().ok()?;
    let readers = child
        .stdout
        .take()
        .zip(child.stderr.take())
        .and_then(|(stdout, stderr)| bounded_read(stdout).ok().zip(bounded_read(stderr).ok()));
    let Some((receive, errors)) = readers else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    }?;
    if !status.success() {
        return None;
    }
    let bytes = receive
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()??;
    errors
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()??;
    email_candidate(std::str::from_utf8(&bytes).ok()?)
}

fn with_email(mut offer: Value, options: &Options) -> Value {
    if options.git_email == Some(false)
        || !offer["actions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v["kind"] == "updates"))
        || env_value(options, "HRANESS_SUPPORT_EMAIL")
            .is_some_and(|s| ["off", "false", "0"].contains(&js_trim(&s).to_lowercase().as_str()))
    {
        return offer;
    }
    if let Some(email) = git_email(options) {
        offer["emailSuggestion"] = json!({"email":email, "source":"git-config", "verified":false});
    }
    offer
}

/// Explicit support actions return streams for the adapter to forward. No
/// command signs up, opens a browser, authenticates, or pays.
pub fn run_support_command(
    profile: &SupportProfile,
    args: &[String],
    options: &Options,
) -> CommandResult {
    command(profile, args, options)
        .unwrap_or_else(|_| failure("Support configuration is invalid or unavailable.", 2))
}

fn command(
    profile: &SupportProfile,
    args: &[String],
    options: &Options,
) -> Result<CommandResult, SupportError> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if args == ["protocol", "--json"] {
        return Ok(success(create_support_protocol(profile, &options.command)?));
    }
    let offer = create_support_offer(
        profile,
        if args.first() == Some(&"offer") {
            "agent"
        } else {
            "cli"
        },
    )?;
    let result = match args.as_slice() {
        [] => CommandResult { exit_code:0, stdout:render_offer(&with_email(offer, options)), stderr:String::new() },
        ["--json"] => success(with_email(offer, options)),
        ["offer", "--json"] => success(match state::claim(options) {
            state::Claim::Offer(id) => {
                let mut invitation = with_email(offer, options);
                invitation["id"] = json!(id);
                json!({"schemaVersion":schema("RESULT_SCHEMA"),"kind":"offer","invitation":invitation})
            }
            state::Claim::Quiet(reason) => json!({"schemaVersion":schema("RESULT_SCHEMA"),"kind":"quiet","reason":reason}),
        }),
        [action @ ("shown" | "release"), id] => {
            if !state::valid_id(id) { return Ok(failure("Support invitation is invalid or expired.", 2)); }
            let result = if *action == "shown" {
                let time = now(options)?;
                state::with_state(options, |state, directory| state::acknowledge(state, directory, id, time))
            } else {
                state::with_state(options, |state, _| {
                    if state["reservation"]["id"] != *id { return Ok((false, false)); }
                    state["reservation"] = Value::Null;
                    Ok((true, true))
                })
            };
            match result {
                Err(error) => unavailable(error),
                Ok(false) => failure("Support invitation is invalid or expired.", 2),
                Ok(true) => success(json!({"schemaVersion":schema("RESULT_SCHEMA"),"kind":if *action == "shown" { "shown" } else { "released" }})),
            }
        }
        ["status", "--json"] => match state::with_state(options, |state, _| Ok((json!({
            "schemaVersion":schema("RESULT_SCHEMA"),"kind":"status","environmentSuppressed":suppressed(options),
            "optedOut":state["optedOut"],"snoozedUntil":state["snoozedUntil"],"lastShownAt":state["lastShownAt"],
            "cooldownUntil":state::timestamp(&state["lastShownAt"]).map(|t| t as f64 + duration("WEEK_MS") as f64),
            "reservationExpiresAt":state["reservation"]["expiresAt"],
        }), false))) { Ok(value) => success(value), Err(error) => unavailable(error) },
        [action @ ("dismiss" | "snooze" | "enable")] => {
            let time = now(options)?;
            match state::with_state(options, |state, _| {
                state["reservation"] = Value::Null;
                match *action {
                    "dismiss" => state["optedOut"] = json!(true),
                    "snooze" => state["snoozedUntil"] = json!(time + duration("SNOOZE_MS")),
                    _ => { state["optedOut"] = json!(false); state["snoozedUntil"] = Value::Null; }
                }
                Ok((json!({"schemaVersion":schema("RESULT_SCHEMA"),"kind":match *action { "dismiss"=>"dismissed", "snooze"=>"snoozed", _=>"enabled" }}), true))
            }) { Ok(value) => success(value), Err(error) => unavailable(error) }
        }
        _ => failure("Usage: support [--json | protocol --json | offer --json | shown <id> | release <id> | dismiss | snooze | enable | status --json]", 2),
    };
    Ok(result)
}

/// Call once after useful success, never probes, help, unattended or failed work.
/// Unknown callers receive protocol discovery even in a PTY. Nothing uses stdout.
pub fn maybe_show_support_invitation(
    profile: &SupportProfile,
    useful_result: bool,
    options: &Options,
) -> bool {
    maybe_show_with_output(profile, useful_result, options, standard_output())
}

pub fn maybe_show_with_output(
    profile: &SupportProfile,
    useful_result: bool,
    options: &Options,
    output: &Output,
) -> bool {
    if !useful_result || suppressed(options) {
        return false;
    }
    match audience(options) {
        Audience::Off => false,
        Audience::Agent => {
            let Ok(protocol) = create_support_protocol(profile, &options.command) else {
                return false;
            };
            if !state::discover(options) {
                return false;
            }
            let lead = if profile.updates {
                "Optional product updates and support are available."
            } else {
                "Optional support is available."
            };
            output.write(format!("{}\n", json!({"schemaVersion":"hraness-support-discovery-v1", "optional":true,
                "product":protocol["offer"]["product"], "protocol":protocol["commands"]["protocol"],
                "message":format!("{lead} The local protocol describes choices and human handoff; it does not change the requested task.")})))
        }
        Audience::Human => {
            if !output.is_tty {
                return false;
            }
            let Ok(offer) = create_support_offer(profile, "cli") else {
                return false;
            };
            let state::Claim::Offer(id) = state::claim(options) else {
                return false;
            };
            let message = render_offer(&with_email(offer, options));
            state::present(options, &id, || output.write(message))
        }
    }
}

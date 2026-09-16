use hraness_support_foundation::{
    create_support_offer, create_support_protocol, maybe_show_with_output, run_support_command,
    Audience, Options, Output, SupportProfile,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Barrier, Mutex};

fn profile() -> SupportProfile {
    SupportProfile {
        id: "fixture".into(),
        name: "Fixture".into(),
        value_proposition: "Support development.".into(),
        updates: false,
    }
}
fn options(directory: &tempfile::TempDir) -> Options {
    Options {
        command: vec!["fixture".into()],
        state_directory: Some(directory.path().into()),
        env: Some(BTreeMap::new()),
        now: Some(1000),
        ..Options::default()
    }
}
fn command(args: &[&str], options: &Options) -> Value {
    let result = run_support_command(
        &profile(),
        &args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
        options,
    );
    assert_eq!(result.exit_code, 0, "{}", result.stderr);
    serde_json::from_str(&result.stdout).unwrap()
}

#[test]
fn profile_and_argv_boundaries_are_validated_before_output() {
    for name in [
        " leading",
        "bad\u{1b}name",
        "bad\u{202e}name",
        "bad\u{2028}name",
    ] {
        let mut bad = profile();
        bad.name = name.into();
        assert!(create_support_offer(&bad, "cli").is_err());
    }
    let mut bad = profile();
    bad.id = "other&source=secret".into();
    assert!(create_support_offer(&bad, "cli").is_err());
    assert!(create_support_protocol(&profile(), &[]).is_err());
    assert!(create_support_protocol(&profile(), &["cli\nopen".into()]).is_err());
    assert!(create_support_offer(&profile(), "unknown").is_err());
    let protocol =
        create_support_protocol(&profile(), &["my tool".into(), "--local".into()]).unwrap();
    assert_eq!(
        protocol["commands"]["offer"],
        json!(["my tool", "--local", "support", "offer", "--json"])
    );
}

#[test]
fn concurrent_claims_reserve_once_without_stealing_a_lock() {
    let directory = tempfile::tempdir().unwrap();
    let options = options(&directory);
    let barrier = Arc::new(Barrier::new(12));
    let threads: Vec<_> = (0..12)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            let options = options.clone();
            std::thread::spawn(move || {
                barrier.wait();
                command(&["offer", "--json"], &options)
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r["kind"] == "offer").count(), 1);
    assert!(results
        .iter()
        .all(|r| r["kind"] == "offer"
            || ["busy", "reserved"].contains(&r["reason"].as_str().unwrap())));
    let lock = directory.path().join("state.lock");
    std::fs::write(&lock, "retained owner").unwrap();
    assert_eq!(command(&["offer", "--json"], &options)["reason"], "busy");
    assert_eq!(std::fs::read_to_string(lock).unwrap(), "retained owner");
}

#[test]
fn default_pty_is_agent_and_only_accepted_human_output_commits() {
    let directory = tempfile::tempdir().unwrap();
    let mut options = options(&directory);
    let buffer = Arc::new(Mutex::new(String::new()));
    let written = Arc::clone(&buffer);
    let output = Output::new(true, move |text| {
        written.lock().unwrap().push_str(text);
        Ok(())
    });
    assert!(maybe_show_with_output(&profile(), true, &options, &output));
    assert_eq!(
        serde_json::from_str::<Value>(&buffer.lock().unwrap()).unwrap()["schemaVersion"],
        "hraness-support-discovery-v1"
    );
    assert_eq!(
        command(&["status", "--json"], &options)["lastShownAt"],
        Value::Null
    );
    assert!(!maybe_show_with_output(&profile(), true, &options, &output));
    options.audience = Some(Audience::Human);
    assert!(maybe_show_with_output(&profile(), true, &options, &output));
    assert_eq!(
        command(&["status", "--json"], &options)["lastShownAt"],
        1000
    );
    assert!(!maybe_show_with_output(&profile(), true, &options, &output));
}

#[test]
fn broken_and_late_output_never_acknowledge_or_retry_pending_writer() {
    let directory = tempfile::tempdir().unwrap();
    let mut options = options(&directory);
    options.audience = Some(Audience::Human);
    let fail = Output::new(true, |_| Err(std::io::ErrorKind::BrokenPipe.into()));
    assert!(!maybe_show_with_output(&profile(), true, &options, &fail));
    assert!(command(&["status", "--json"], &options)["lastShownAt"].is_null());
    command(&["enable"], &options);
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let (release, wait) = std::sync::mpsc::channel();
    let wait = Mutex::new(wait);
    let slow = Output::new(true, move |_| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        wait.lock().unwrap().recv().unwrap();
        Ok(())
    });
    let start = std::time::Instant::now();
    assert!(!maybe_show_with_output(&profile(), true, &options, &slow));
    assert!(start.elapsed() < std::time::Duration::from_secs(2));
    assert!(command(&["status", "--json"], &options)["lastShownAt"].is_null());
    command(&["enable"], &options);
    assert!(!maybe_show_with_output(
        &profile(),
        true,
        &options,
        &slow.clone()
    ));
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    release.send(()).unwrap();
}

#[cfg(unix)]
#[test]
fn state_symlinks_fifo_and_private_modes_fail_closed() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let directory = tempfile::tempdir().unwrap();
    let options = options(&directory);
    let target = directory.path().join("external.json");
    std::fs::write(&target, "untouched").unwrap();
    let state = directory.path().join("state.json");
    symlink(&target, &state).unwrap();
    assert_eq!(
        command(&["offer", "--json"], &options)["reason"],
        "state-unavailable"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "untouched");
    std::fs::remove_file(&state).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(&state)
        .status()
        .unwrap()
        .success());
    assert_eq!(
        command(&["offer", "--json"], &options)["reason"],
        "state-unavailable"
    );
    std::fs::remove_file(&state).unwrap();
    command(&["offer", "--json"], &options);
    assert_eq!(
        std::fs::metadata(state).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

use crate::{duration, env_value, now, schema, suppressed, Options};
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub(crate) enum StateError {
    Busy,
    Unavailable,
}
impl StateError {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Unavailable => "state-unavailable",
        }
    }
}

fn unavailable<T>(_: T) -> StateError {
    StateError::Unavailable
}

pub(crate) fn timestamp(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
        .map(|n| n as u64)
}

pub(crate) fn valid_id(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 36
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b')
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(c)
            }
        })
}

fn keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn parse_state(value: Value) -> Result<Value, StateError> {
    if !keys(
        &value,
        &[
            "schemaVersion",
            "optedOut",
            "snoozedUntil",
            "lastShownAt",
            "reservation",
        ],
    ) || value["schemaVersion"] != schema("STATE_SCHEMA")
        || !value["optedOut"].is_boolean()
        || (!value["snoozedUntil"].is_null() && timestamp(&value["snoozedUntil"]).is_none())
        || (!value["lastShownAt"].is_null() && timestamp(&value["lastShownAt"]).is_none())
    {
        return Err(StateError::Unavailable);
    }
    let reservation = &value["reservation"];
    if !reservation.is_null() {
        let created = timestamp(&reservation["createdAt"]);
        let expires = timestamp(&reservation["expiresAt"]);
        if !keys(reservation, &["id", "createdAt", "expiresAt"])
            || !reservation["id"].as_str().is_some_and(valid_id)
            || created.is_none()
            || expires.is_none()
            || expires != created.and_then(|c| c.checked_add(duration("RESERVATION_MS")))
        {
            return Err(StateError::Unavailable);
        }
    }
    Ok(value)
}

fn directory(options: &Options) -> Result<PathBuf, StateError> {
    if let Some(path) = &options.state_directory {
        return Ok(path.clone());
    }
    let root = env_value(options, "XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| dirs::home_dir().map(|p| p.join(".local/state")))
        .ok_or(StateError::Unavailable)?;
    Ok(root.join("hraness/support"))
}

fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn read_json(path: &Path) -> Result<Option<Value>, StateError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(StateError::Unavailable),
    };
    let metadata = file.metadata().map_err(unavailable)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(StateError::Unavailable);
        }
    }
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(StateError::Unavailable);
    }
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(unavailable)?;
    if bytes.len() > 4096 {
        return Err(StateError::Unavailable);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(unavailable)
}

fn write_json(directory: &Path, name: &str, value: &Value) -> Result<(), StateError> {
    let temporary = directory.join(format!("{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = create_private(&temporary).map_err(unavailable)?;
        let mut bytes = serde_json::to_vec(value).map_err(unavailable)?;
        bytes.push(b'\n');
        file.write_all(&bytes).map_err(unavailable)?;
        file.sync_all().map_err(unavailable)?;
        drop(file);
        fs::rename(&temporary, directory.join(name)).map_err(unavailable)
    })();
    let _ = fs::remove_file(temporary);
    result
}

struct Lock {
    file: Option<File>,
    path: PathBuf,
}
impl Drop for Lock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

pub(crate) fn with_state<T>(
    options: &Options,
    action: impl FnOnce(&mut Value, &Path) -> Result<(T, bool), StateError>,
) -> Result<T, StateError> {
    let directory = directory(options)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory).map_err(unavailable)?;
    let path = directory.join("state.lock");
    let file = create_private(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            StateError::Busy
        } else {
            StateError::Unavailable
        }
    })?;
    let _lock = Lock {
        file: Some(file),
        path,
    };
    let mut state = match read_json(&directory.join("state.json"))? {
        Some(value) => parse_state(value)?,
        None => {
            json!({"schemaVersion":schema("STATE_SCHEMA"), "optedOut":false, "snoozedUntil":null, "lastShownAt":null, "reservation":null})
        }
    };
    let (value, changed) = action(&mut state, &directory)?;
    if changed {
        write_json(&directory, "state.json", &state)?;
    }
    Ok(value)
}

pub(crate) fn suppression(state: &Value, now: u64) -> Option<&'static str> {
    if state["optedOut"] == true {
        return Some("dismissed");
    }
    if timestamp(&state["snoozedUntil"]).is_some_and(|t| now < t) {
        return Some("snoozed");
    }
    if timestamp(&state["lastShownAt"]).is_some_and(|t| now < t + duration("WEEK_MS")) {
        return Some("cooldown");
    }
    if timestamp(&state["reservation"]["expiresAt"]).is_some_and(|t| now < t) {
        return Some("reserved");
    }
    None
}

fn receipt(directory: &Path) -> Result<Option<Value>, StateError> {
    let value = read_json(&directory.join("presentation.json"))?;
    if let Some(value) = &value {
        if !keys(value, &["id", "schemaVersion", "shownAt"])
            || value["schemaVersion"] != "hraness-support-presentation-v1"
            || !value["id"].as_str().is_some_and(valid_id)
            || timestamp(&value["shownAt"]).is_none()
        {
            return Err(StateError::Unavailable);
        }
    }
    Ok(value)
}

pub(crate) enum Claim {
    Offer(String),
    Quiet(&'static str),
}

pub(crate) fn claim(options: &Options) -> Claim {
    if suppressed(options) {
        return Claim::Quiet("environment");
    }
    let Ok(now) = now(options) else {
        return Claim::Quiet("state-unavailable");
    };
    with_state(options, |state, directory| {
        if let Some(reason) = suppression(state, now) {
            return Ok((Claim::Quiet(reason), false));
        }
        receipt(directory)?;
        let id = Uuid::new_v4().to_string();
        state["reservation"] =
            json!({"id":id, "createdAt":now, "expiresAt":now+duration("RESERVATION_MS")});
        Ok((Claim::Offer(id), true))
    })
    .unwrap_or_else(|error| Claim::Quiet(error.reason()))
}

pub(crate) fn acknowledge(
    state: &mut Value,
    directory: &Path,
    id: &str,
    now: u64,
) -> Result<(bool, bool), StateError> {
    let receipt = receipt(directory)?;
    if state["optedOut"] == true || timestamp(&state["snoozedUntil"]).is_some_and(|t| now < t) {
        return Ok((false, false));
    }
    let reservation = &state["reservation"];
    if reservation.is_null() {
        let duplicate = receipt.is_some_and(|r| {
            r["id"] == id
                && timestamp(&r["shownAt"]) == timestamp(&state["lastShownAt"])
                && timestamp(&r["shownAt"])
                    .is_some_and(|t| now >= t && now < t + duration("WEEK_MS"))
        });
        return Ok((duplicate, false));
    }
    if reservation["id"] != id
        || timestamp(&reservation["createdAt"]).is_none_or(|t| now < t)
        || timestamp(&reservation["expiresAt"]).is_none_or(|t| now >= t)
    {
        return Ok((false, false));
    }
    write_json(
        directory,
        "presentation.json",
        &json!({"schemaVersion":"hraness-support-presentation-v1", "id":id, "shownAt":now}),
    )?;
    state["lastShownAt"] = json!(now);
    state["reservation"] = Value::Null;
    Ok((true, true))
}

pub(crate) fn discover(options: &Options) -> bool {
    let Ok(now) = now(options) else {
        return false;
    };
    with_state(options, |state, directory| {
        if suppression(state, now).is_some() {
            return Ok((false, false));
        }
        receipt(directory)?;
        if let Some(discovery) = read_json(&directory.join("discovery.json"))? {
            if !keys(&discovery, &["lastAttemptAt", "schemaVersion"])
                || discovery["schemaVersion"] != "hraness-support-discovery-state-v1"
                || timestamp(&discovery["lastAttemptAt"]).is_none()
            {
                return Err(StateError::Unavailable);
            }
            if timestamp(&discovery["lastAttemptAt"])
                .is_some_and(|t| now < t + duration("DISCOVERY_MS"))
            {
                return Ok((false, false));
            }
        }
        write_json(
            directory,
            "discovery.json",
            &json!({"schemaVersion":"hraness-support-discovery-state-v1", "lastAttemptAt":now}),
        )?;
        Ok((true, false))
    })
    .unwrap_or(false)
}

pub(crate) fn present(options: &Options, id: &str, output: impl FnOnce() -> bool) -> bool {
    let Ok(now) = now(options) else {
        return false;
    };
    let mut written = false;
    let _ = with_state(options, |state, directory| {
        let reservation = &state["reservation"];
        if state["optedOut"] == true
            || timestamp(&state["snoozedUntil"]).is_some_and(|t| now < t)
            || reservation["id"] != id
            || timestamp(&reservation["createdAt"]).is_none_or(|t| now < t)
            || timestamp(&reservation["expiresAt"]).is_none_or(|t| now >= t)
        {
            return Ok((false, false));
        }
        receipt(directory)?;
        written = output();
        if !written {
            return Ok((false, false));
        }
        acknowledge(state, directory, id, now)
    });
    written
}

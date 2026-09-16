//! Optional browser handoffs and agent invitations. Accounts retains all
//! signup, consent, price and payment authority. No function launches a browser.
#![forbid(unsafe_code)]

mod runtime;
mod state;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

pub use runtime::{
    maybe_show_support_invitation, maybe_show_with_output, run_support_command, Output,
};

/// Product-owned, public presentation data; never account or credential data.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportProfile {
    pub id: String,
    pub name: String,
    pub value_proposition: String,
    pub updates: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
    Agent,
    Human,
    Off,
}

/// Explicit host values override environment selection. Default audience is
/// agent even in a PTY. Explicit support requests remain available when off.
#[derive(Clone, Default)]
pub struct Options {
    pub command: Vec<String>,
    pub audience: Option<Audience>,
    pub state_directory: Option<PathBuf>,
    pub env: Option<BTreeMap<String, String>>,
    pub now: Option<u64>,
    pub cwd: Option<PathBuf>,
    pub git_email: Option<bool>,
}

/// Product adapters forward these exact streams and exit status only for an
/// explicit support command. Incidental hooks never write ordinary stdout.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupportError {
    InvalidConfiguration,
}

pub(crate) fn contract() -> &'static Value {
    static VALUE: OnceLock<Value> = OnceLock::new();
    VALUE.get_or_init(|| {
        serde_json::from_str(include_str!("contract-v1.json")).expect("verified generated contract")
    })
}

pub(crate) fn duration(name: &str) -> u64 {
    contract()["policy"][name]
        .as_u64()
        .expect("verified generated duration")
}

pub(crate) fn schema(name: &str) -> &'static str {
    contract()["policy"][name]
        .as_str()
        .expect("verified generated schema")
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn plain_text(value: &str, max: usize) -> bool {
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    !value.is_empty()
        && value.encode_utf16().count() <= max
        && js_trim(value) == value
        && !UNSAFE
            .get_or_init(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").expect("constant regex"))
            .is_match(value)
}

fn valid_profile(profile: &SupportProfile) -> bool {
    let id = profile.id.as_bytes();
    (1..=48).contains(&id.len())
        && id[0].is_ascii_lowercase()
        && id
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && plain_text(&profile.name, 80)
        && plain_text(&profile.value_proposition, 240)
}

/// Pure, portable offer. Does not read preferences, Git, or the network.
pub fn create_support_offer(profile: &SupportProfile, source: &str) -> Result<Value, SupportError> {
    if !valid_profile(profile) || !["cli", "agent", "web", "desktop", "skill"].contains(&source) {
        return Err(SupportError::InvalidConfiguration);
    }
    let template = &contract()["protocol"]["offer"];
    let support = &template["actions"][0];
    let url = support["url"]
        .as_str()
        .expect("verified generated URL")
        .replace(
            "product=contract-product",
            &format!("product={}", profile.id),
        )
        .replace("source=agent", &format!("source={source}"));
    let mut actions = Vec::new();
    if profile.updates {
        actions.push(json!({
            "kind": "updates",
            "label": contract()["presentation"]["updatesLabel"].as_str().expect("generated label").replace("PRODUCT_NAME", &profile.name),
            "url": url.replace("#support", "#updates"),
        }));
    }
    actions.push(json!({"kind":"support", "label":support["label"], "url":url}));
    Ok(json!({
        "schemaVersion": template["schemaVersion"], "optional": true,
        "product": {"id":profile.id,"name":profile.name},
        "valueProposition": profile.value_proposition, "actions": actions,
    }))
}

/// Pure protocol with argv arrays. Reading it claims or displays no invitation.
pub fn create_support_protocol(
    profile: &SupportProfile,
    command: &[String],
) -> Result<Value, SupportError> {
    if !(1..=8).contains(&command.len()) || !command.iter().all(|part| plain_text(part, 240)) {
        return Err(SupportError::InvalidConfiguration);
    }
    let mut protocol = contract()["protocol"].clone();
    protocol["offer"] = create_support_offer(profile, "agent")?;
    for value in protocol["commands"]
        .as_object_mut()
        .expect("generated argv map")
        .values_mut()
    {
        let args = value.as_array_mut().expect("generated argv");
        args.splice(0..1, command.iter().cloned().map(Value::String));
    }
    Ok(protocol)
}

pub(crate) fn render_offer(offer: &Value) -> String {
    let presentation = &contract()["presentation"];
    let mut lines = vec![presentation["heading"]
        .as_str()
        .expect("generated heading")
        .replace(
            "VALUE_PROPOSITION",
            offer["valueProposition"].as_str().expect("validated offer"),
        )];
    for action in offer["actions"].as_array().expect("validated actions") {
        lines.push(format!(
            "{}: {}",
            action["label"].as_str().expect("label"),
            action["url"].as_str().expect("URL")
        ));
    }
    if let Some(email) = offer["emailSuggestion"]["email"].as_str() {
        lines.push(
            presentation["emailSuggestion"]
                .as_str()
                .expect("generated email text")
                .replace("EMAIL_ADDRESS", email),
        );
    }
    lines.push(
        presentation["payment"]
            .as_str()
            .expect("generated payment text")
            .to_owned(),
    );
    lines.join("\n") + "\n"
}

pub(crate) fn env_value(options: &Options, key: &str) -> Option<String> {
    match &options.env {
        Some(env) => env.get(key).cloned(),
        None => std::env::var(key).ok(),
    }
}

pub(crate) fn audience(options: &Options) -> Audience {
    options.audience.unwrap_or_else(|| {
        match env_value(options, "HRANESS_SUPPORT_AUDIENCE").as_deref() {
            None | Some("agent") => Audience::Agent,
            Some("human") => Audience::Human,
            _ => Audience::Off,
        }
    })
}

pub(crate) fn suppressed(options: &Options) -> bool {
    if matches!(audience(options), Audience::Off)
        || env_value(options, "HRANESS_SUPPORT")
            .is_some_and(|s| ["off", "false", "0"].contains(&js_trim(&s).to_lowercase().as_str()))
    {
        return true;
    }
    [
        "CI",
        "CONTINUOUS_INTEGRATION",
        "GITHUB_ACTIONS",
        "TF_BUILD",
        "BUILD_NUMBER",
        "TEAMCITY_VERSION",
        "JENKINS_URL",
    ]
    .iter()
    .any(|name| {
        env_value(options, name)
            .is_some_and(|s| !["", "false", "0"].contains(&js_trim(&s).to_lowercase().as_str()))
    })
}

pub(crate) fn now(options: &Options) -> Result<u64, SupportError> {
    let value = options.now.or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| u64::try_from(d.as_millis()).ok())
    });
    value
        .filter(|n| *n <= 9_007_199_254_740_991 - duration("SNOOZE_MS"))
        .ok_or(SupportError::InvalidConfiguration)
}

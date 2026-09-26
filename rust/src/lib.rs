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

/// Explicit host values override environment selection. Unset, agent markers
/// select agent, an interactive stderr selects human, and anything else stays
/// quiet. Explicit support requests remain available when off.
#[derive(Clone, Default)]
pub struct Options {
    pub command: Vec<String>,
    pub audience: Option<Audience>,
    /// Whether stderr is a terminal. `None` checks the process's stderr.
    pub stderr_is_terminal: Option<bool>,
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

pub(crate) fn human_copy(key: &str) -> &'static str {
    contract()["human"][key]
        .as_str()
        .expect("generated human copy")
}

fn ascii_only(options: &Options) -> bool {
    static UTF8: OnceLock<Regex> = OnceLock::new();
    let utf8 = UTF8.get_or_init(|| Regex::new(r"(?i)utf-?8").expect("constant regex"));
    env_value(options, "HRANESS_ASCII").as_deref() == Some("1")
        || env_value(options, "TERM").as_deref() == Some("dumb")
        || !["LC_ALL", "LC_CTYPE", "LANG"]
            .iter()
            .any(|name| env_value(options, name).is_some_and(|value| utf8.is_match(&value)))
}

/// Replace CLI symbols with their ASCII fallbacks on plain terminals.
pub(crate) fn symbols(text: &str, options: &Options) -> String {
    if !ascii_only(options) {
        return text.to_owned();
    }
    let table = &contract()["asciiSymbols"];
    text.chars()
        .map(|c| {
            table[c.to_string().as_str()]
                .as_str()
                .map_or_else(|| c.to_string(), str::to_owned)
        })
        .collect()
}

pub(crate) fn command_text(options: &Options) -> String {
    options
        .command
        .iter()
        .enumerate()
        .map(|(index, part)| {
            if index == 0 {
                part.rsplit(['/', '\\']).next().unwrap_or(part).to_owned()
            } else {
                part.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Fill `{command}`, `{product}`, `{date}` and `{argument}` like the Node adapter.
pub(crate) fn support_line(
    template: &str,
    profile: &SupportProfile,
    options: &Options,
    values: &[(&str, &str)],
) -> String {
    let command = command_text(options);
    // Without a product prefix the command is plain `support …`.
    let mut text = if command.is_empty() {
        template.replace("{command} ", "")
    } else {
        template.to_owned()
    };
    let mut all = vec![
        ("command", command.as_str()),
        ("product", profile.name.as_str()),
    ];
    all.extend_from_slice(values);
    text = fill(&text, &all);
    symbols(&text, options)
}

fn fill(template: &str, values: &[(&str, &str)]) -> String {
    static PLACEHOLDER: OnceLock<Regex> = OnceLock::new();
    PLACEHOLDER
        .get_or_init(|| Regex::new(r"\{(command|product|date|argument)\}").expect("constant regex"))
        .replace_all(template, |captures: &regex::Captures<'_>| {
            let key = &captures[1];
            values
                .iter()
                .find(|(name, _)| *name == key)
                .map_or_else(|| captures[0].to_owned(), |(_, value)| (*value).to_owned())
        })
        .into_owned()
}

/// UTC `YYYY-MM-DD` for epoch milliseconds, matching `Date.prototype.toISOString`.
pub(crate) fn iso_date(epoch_ms: u64) -> String {
    let days = i64::try_from(epoch_ms / 86_400_000).unwrap_or(i64::MAX / 2);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The standard `Help & support` row for a desktop-foundation menu kit v2
/// snapshot. The product maps its action ID to [`support_menu_url`].
pub fn support_menu_item() -> Value {
    contract()["menuItem"].clone()
}

/// The page a desktop `Help & support` row opens: both updates and support choices.
pub fn support_menu_url(profile: &SupportProfile) -> Result<String, SupportError> {
    let offer = create_support_offer(profile, "desktop")?;
    let url = offer["actions"][0]["url"].as_str().expect("validated URL");
    Ok(url.split('#').next().unwrap_or(url).to_owned())
}

pub(crate) fn env_value(options: &Options, key: &str) -> Option<String> {
    match &options.env {
        Some(env) => env.get(key).cloned(),
        None => std::env::var(key).ok(),
    }
}

fn role(value: &str) -> Audience {
    match value {
        "agent" => Audience::Agent,
        "human" => Audience::Human,
        _ => Audience::Off,
    }
}

// TODO(df-0.8): use hraness-cli-kit `audience::detect`. This copy follows the
// shared Hraness CLI contract; the marker names come from the generated contract.
/// A role the host or environment chose on purpose, or `None` to infer one.
pub(crate) fn explicit_audience(options: &Options) -> Option<Audience> {
    if let Some(audience) = options.audience {
        return Some(audience);
    }
    if let Some(shared) = env_value(options, "HRANESS_AUDIENCE")
        .filter(|value| ["human", "agent", "quiet", "off"].contains(&value.as_str()))
    {
        return Some(role(&shared));
    }
    // Older hosts set the support-only variable; invalid values stay quiet.
    env_value(options, "HRANESS_SUPPORT_AUDIENCE").map(|value| role(&value))
}

/// Explicit role, then agent markers, then human at an interactive stderr, else off.
pub(crate) fn audience(options: &Options, stderr_is_terminal: bool) -> Audience {
    explicit_audience(options).unwrap_or_else(|| {
        let agent = contract()["agentMarkers"]
            .as_array()
            .expect("generated agent markers")
            .iter()
            .filter_map(Value::as_str)
            .any(|name| env_value(options, name).is_some_and(|value| !value.is_empty()));
        if agent {
            Audience::Agent
        } else if stderr_is_terminal {
            Audience::Human
        } else {
            Audience::Off
        }
    })
}

pub(crate) fn suppressed(options: &Options) -> bool {
    // Products set the support-only variable to off for their own child processes.
    // Only an explicit host option overrides that.
    let legacy_off = options.audience.is_none()
        && env_value(options, "HRANESS_SUPPORT_AUDIENCE")
            .is_some_and(|value| value != "agent" && value != "human");
    if matches!(explicit_audience(options), Some(Audience::Off))
        || legacy_off
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

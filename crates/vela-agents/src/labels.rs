//! Labels of the conversations, from the Vela model: the small model Vela runs for its own
//! tasks, apart from the tiers of the agents. It gives each conversation one or two words to find
//! it again ("refunds", "flaky test"); the ticket of the space comes first.
//!
//! ```toml
//! [agents.vela]
//! enabled = true        # default
//! harness = "claude"    # default: the first installed harness
//! model = "haiku"       # default: the `low` tier model of that harness
//! ```

use vela_core::config::AgentsConfig;
use vela_core::links::detect_keys;
use vela_core::model::Tier;

use crate::tiers::HARNESSES;

/// At most this many words come from the model; the ticket comes on top.
pub const MAX_LABELS: usize = 2;
const MAX_CHARS: usize = 24;

/// The harness and model the Vela model runs on, None when it is off or nothing is installed.
pub fn pick(
    cfg: &AgentsConfig,
    installed: &[String],
    default_on: bool,
) -> Option<(String, Option<String>)> {
    if !cfg.vela.enabled.unwrap_or(default_on) {
        return None;
    }
    let harness = match cfg
        .vela
        .harness
        .as_deref()
        .map(str::trim)
        .filter(|h| !h.is_empty())
    {
        Some(h) => installed.iter().any(|i| i == h).then(|| h.to_string())?,
        None => HARNESSES
            .iter()
            .find(|h| installed.iter().any(|i| i == *h))?
            .to_string(),
    };
    let model = cfg
        .vela
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| {
            cfg.tiers
                .get(&harness)
                .and_then(|t| t.get(Tier::Low))
                .map(str::to_string)
        })
        .or_else(|| (harness == "claude").then(|| "haiku".to_string()));
    Some((harness, model))
}

/// The title is cut at this many characters.
const MAX_TITLE: usize = 60;

/// What the Vela model is asked for one request.
pub fn prompt(request: &str) -> String {
    let request: String = request.trim().chars().take(4000).collect();
    format!(
        "Name this request to a coding agent so the conversation is easy to find later. Do not \
         use any tool. Answer with exactly two lines and nothing else:\n\
         Title: a title of three to seven words, in the language of the request, no final period\n\
         Labels: one or two labels (one or two words each, lowercase), separated by a comma: the \
         feature, the area of the code, or the kind of work (bug, test, refactor)\n\n\
         Request:\n{request}"
    )
}

/// The title in what the model answered, None when it gave none.
pub fn parse_title(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let l = l.trim().trim_start_matches(['-', '*', '#']).trim();
        let (k, v) = l.split_once(':')?;
        if !k.trim().eq_ignore_ascii_case("title") {
            return None;
        }
        let v = v.trim().trim_matches(['"', '\'', '`', '*', '.']).trim();
        if v.is_empty() {
            return None;
        }
        let mut t: String = v.chars().take(MAX_TITLE).collect();
        if v.chars().count() > MAX_TITLE {
            t = format!("{}…", t.trim_end());
        }
        Some(t)
    })
}

/// Words that say nothing about a conversation.
const EMPTY: &[&str] = &[
    "label", "labels", "none", "n/a", "request", "task", "code", "agent",
];

/// The labels in what the model answered.
pub fn parse(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let text: String = text
        .lines()
        .filter(|l| !l.trim().to_lowercase().starts_with("title:"))
        .map(|l| {
            let t = l.trim();
            match t.get(..7) {
                Some(h) if h.eq_ignore_ascii_case("labels:") => &t[7..],
                _ => t,
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    for part in text.split([',', '\n', ';', '|', '·']) {
        let w = part
            .trim()
            .trim_start_matches(['-', '*', '•', '#', '1', '2', '3', '.', ')'])
            .trim()
            .trim_matches(['"', '\'', '`', '*', '.', '[', ']'])
            .trim();
        if w.is_empty() || w.chars().count() > MAX_CHARS || w.split_whitespace().count() > 3 {
            continue;
        }
        // Issue keys keep their case, the rest is lowercase.
        let w = if detect_keys(w).first().map(String::as_str) == Some(w) {
            w.to_string()
        } else {
            w.to_lowercase()
        };
        if EMPTY.contains(&w.as_str()) || out.iter().any(|o| o.eq_ignore_ascii_case(&w)) {
            continue;
        }
        out.push(w);
        if out.len() == MAX_LABELS {
            break;
        }
    }
    out
}

/// The labels known without a model: the ticket of the space, else the first issue key of the
/// request.
pub fn known(ticket: Option<&str>, request: &str) -> Vec<String> {
    match ticket.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => vec![t.to_string()],
        None => detect_keys(request).into_iter().take(1).collect(),
    }
}

/// `known` first, then the model's labels that are not already there.
pub fn join(known: &[String], found: Vec<String>) -> Vec<String> {
    let mut out = known.to_vec();
    for f in found {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&f)) {
            out.push(f);
        }
    }
    out.truncate(known.len() + MAX_LABELS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use vela_core::config::{TierModels, VelaModelConfig};

    #[test]
    fn parses_what_models_answer() {
        assert_eq!(parse("refunds, checkout"), vec!["refunds", "checkout"]);
        assert_eq!(parse("Labels: Flaky Test\n"), vec!["flaky test"]);
        assert_eq!(
            parse("- `billing`\n- webhooks\n- extra"),
            vec!["billing", "webhooks"]
        );
        assert_eq!(parse("PAY-412, bug"), vec!["PAY-412", "bug"]);
        assert!(parse("this is a whole sentence that explains nothing useful").is_empty());
        assert_eq!(parse("label, none, auth"), vec!["auth"]);
        assert_eq!(
            parse("Title: Fix the refund webhook\nLabels: refunds, webhooks"),
            vec!["refunds", "webhooks"]
        );
    }

    #[test]
    fn finds_the_title() {
        assert_eq!(
            parse_title("Title: \"Fix the refund webhook.\"\nLabels: a"),
            Some("Fix the refund webhook".into())
        );
        assert_eq!(parse_title("refunds, webhooks"), None);
        assert!(
            parse_title(&format!("Title: {}", "x".repeat(100)))
                .unwrap()
                .ends_with('…')
        );
    }

    #[test]
    fn ticket_first_then_the_model() {
        let k = known(Some("PAY-1"), "fix PAY-2");
        assert_eq!(k, vec!["PAY-1"]);
        assert_eq!(known(None, "see PAY-2 and PAY-3"), vec!["PAY-2"]);
        assert_eq!(
            join(&k, vec!["pay-1".into(), "refunds".into(), "ui".into()]),
            vec!["PAY-1", "refunds", "ui"]
        );
    }

    #[test]
    fn picks_harness_and_model() {
        let installed = vec!["codex".to_string(), "claude".to_string()];
        let mut cfg = AgentsConfig::default();
        assert_eq!(
            pick(&cfg, &installed, true),
            Some(("claude".into(), Some("haiku".into())))
        );
        assert_eq!(pick(&cfg, &installed, false), None);
        cfg.tiers.insert(
            "codex".into(),
            TierModels {
                low: Some("gpt-mini".into()),
                ..Default::default()
            },
        );
        cfg.vela = VelaModelConfig {
            enabled: Some(true),
            harness: Some("codex".into()),
            model: None,
            ..Default::default()
        };
        assert_eq!(
            pick(&cfg, &installed, false),
            Some(("codex".into(), Some("gpt-mini".into())))
        );
        cfg.vela.harness = Some("opencode".into());
        assert_eq!(pick(&cfg, &installed, true), None);
    }
}

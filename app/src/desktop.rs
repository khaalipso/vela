//! Desktop notifications when an agent asks a question, finishes or fails, sent only while no
//! Vela window has the focus (when it has, the Up next island already shows it).

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;
use vela_agents::{AgentEvent, Notice};
use vela_core::{Vela, store};

/// Title and body of the notification for an agent event, None for events that need none.
pub fn message(space: &str, agent: &str, event: &AgentEvent) -> Option<(String, String)> {
    let who = role_of(agent);
    match event {
        AgentEvent::Question { text, .. } => {
            Some((format!("{who} asks a question · {space}"), clip(text, 180)))
        }
        AgentEvent::Done { summary } => Some((
            format!("{who} is done · {space}"),
            if summary.trim().is_empty() {
                "Its proposals are ready to review.".to_string()
            } else {
                clip(summary, 180)
            },
        )),
        AgentEvent::Failed { error } if error != "cancelled" => {
            Some((format!("{who} failed · {space}"), clip(error, 180)))
        }
        _ => None,
    }
}

/// `developer-2` → `Developer`.
fn role_of(agent: &str) -> String {
    let role = agent
        .rsplit_once('-')
        .filter(|(_, n)| n.chars().all(|c| c.is_ascii_digit()))
        .map_or(agent, |(r, _)| r);
    let mut c = role.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => "Agent".to_string(),
    }
}

fn clip(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        one.chars().take(n - 1).collect::<String>() + "…"
    }
}

pub fn notify<R: Runtime>(app: &AppHandle<R>, n: &Notice) {
    let focused = app
        .webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false));
    if focused {
        return;
    }
    let space = app
        .try_state::<Vela>()
        .and_then(|v| store::load(&v, &n.space_id).ok())
        .map_or_else(|| n.space_id.clone(), |s| s.name);
    if let Some((title, body)) = message(&space, &n.agent_id, &n.event) {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_for_question_done_and_failure_only() {
        let q = AgentEvent::Question {
            text: "Use the new client?".into(),
            options: vec![],
            tools: vec![],
        };
        let (t, b) = message("Billing", "developer-2", &q).unwrap();
        assert_eq!(t, "Developer asks a question · Billing");
        assert_eq!(b, "Use the new client?");
        let d = AgentEvent::Done {
            summary: String::new(),
        };
        assert!(
            message("B", "reviewer-1", &d)
                .unwrap()
                .0
                .starts_with("Reviewer is done")
        );
        let c = AgentEvent::Failed {
            error: "cancelled".into(),
        };
        assert!(message("B", "x-1", &c).is_none());
        let m = AgentEvent::Message { text: "hi".into() };
        assert!(message("B", "x-1", &m).is_none());
    }
}

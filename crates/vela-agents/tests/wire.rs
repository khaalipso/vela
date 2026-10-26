//! The JSON the UI receives: field names are part of the contract (`ui/src/lib/types.ts`).

use serde_json::json;
use vela_agents::{AgentEvent, Notice};

#[test]
fn events_are_camel_case_and_tagged() {
    let cases = [
        (
            AgentEvent::SessionStarted {
                session: "s".into(),
            },
            json!({"type": "sessionStarted", "session": "s"}),
        ),
        (
            AgentEvent::ToolCall {
                name: "Edit".into(),
                summary: "a.rs".into(),
            },
            json!({"type": "toolCall", "name": "Edit", "summary": "a.rs"}),
        ),
        (
            AgentEvent::FileChanged {
                path: "a.rs".into(),
            },
            json!({"type": "fileChanged", "path": "a.rs"}),
        ),
        (
            AgentEvent::Question {
                text: "ok?".into(),
                options: vec!["Yes".into()],
                tools: vec![],
            },
            json!({"type": "question", "text": "ok?", "options": ["Yes"]}),
        ),
        (
            AgentEvent::Usage {
                input_tokens: 1,
                output_tokens: 2,
                cost_usd: Some(0.5),
                model: "m".into(),
            },
            json!({"type": "usage", "inputTokens": 1, "outputTokens": 2, "costUsd": 0.5, "model": "m"}),
        ),
        (
            AgentEvent::Done {
                summary: "x".into(),
            },
            json!({"type": "done", "summary": "x"}),
        ),
        (
            AgentEvent::Failed { error: "e".into() },
            json!({"type": "failed", "error": "e"}),
        ),
    ];
    for (ev, want) in cases {
        let got = serde_json::to_value(&ev).unwrap();
        assert_eq!(got, want);
        let back: AgentEvent = serde_json::from_value(got).unwrap();
        assert_eq!(back, ev);
    }
}

#[test]
fn a_notice_carries_the_space_agent_and_event() {
    let n = Notice {
        space_id: "refunds".into(),
        agent_id: "developer-1".into(),
        event: AgentEvent::Message { text: "hi".into() },
    };
    assert_eq!(
        serde_json::to_value(&n).unwrap(),
        json!({"spaceId": "refunds", "agentId": "developer-1", "event": {"type": "message", "text": "hi"}})
    );
}

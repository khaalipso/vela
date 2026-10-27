//! Glue between the agent manager and the app: events for the UI (`vela://agent`) and the
//! debounced refresh of the proposals when an agent writes files or ends a run.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use vela_agents::{AgentEvent, Emit, Notice};

use crate::watch::{ChangeEvent, ChangeKind, Emit as EmitChange};

pub const EVENT: &str = "vela://agent";
/// Quiet time after the last file an agent wrote before the proposals are recomputed.
pub const REFRESH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Collapses bursts of "an agent changed files" into one change event per space.
#[derive(Default)]
pub struct Refresher {
    seq: Mutex<HashMap<String, u64>>,
}

impl Refresher {
    /// Emit a `File` change for the space once `delay` passes without another call.
    pub fn schedule(self: &Arc<Self>, space_id: &str, delay: Duration, change: &EmitChange) {
        let n = {
            let mut m = self.seq.lock().unwrap_or_else(|e| e.into_inner());
            let n = m.entry(space_id.to_string()).or_insert(0);
            *n += 1;
            *n
        };
        let (me, id, change) = (self.clone(), space_id.to_string(), change.clone());
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            let current = me
                .seq
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .copied();
            if current == Some(n) {
                change(ChangeEvent {
                    space_id: id,
                    kind: ChangeKind::File,
                });
            }
        });
    }
}

/// Does this event change what the agents propose?
pub fn changes_proposals(e: &AgentEvent) -> bool {
    matches!(
        e,
        AgentEvent::FileChanged { .. } | AgentEvent::Done { .. } | AgentEvent::Failed { .. }
    )
}

/// The sink the agent manager writes to: `send` delivers the notice to the UI, and events
/// that change the proposals schedule a (debounced) change event through `change`.
pub fn sink(
    send: Arc<dyn Fn(&Notice) + Send + Sync>,
    change: EmitChange,
    refresher: Arc<Refresher>,
    delay: Duration,
) -> Emit {
    Arc::new(move |n: Notice| {
        if changes_proposals(&n.event) {
            crate::commands::invalidate_hunks(&n.space_id);
        }
        send(&n);
        if changes_proposals(&n.event) {
            refresher.schedule(&n.space_id, delay, &change);
        }
    })
}

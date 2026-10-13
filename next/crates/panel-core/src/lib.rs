use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use uuid::Uuid;

pub type SessionId = String;

pub fn new_session_id() -> SessionId {
    Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub id: SessionId,
    pub provider: String,
    pub cwd: PathBuf,
}

impl SessionConfig {
    pub fn new(provider: impl Into<String>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            id: new_session_id(),
            provider: provider.into(),
            cwd: cwd.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PanelEvent {
    SessionStarted {
        session_id: SessionId,
        provider: String,
    },
    AgentText {
        session_id: SessionId,
        text: String,
        append: bool,
    },
    AgentStatus {
        session_id: SessionId,
        status: String,
        detail: Option<String>,
    },
    Activity {
        session_id: SessionId,
        activity_id: String,
        state: ActivityState,
        label: String,
        detail: Option<String>,
        success: Option<bool>,
    },
    FileChanged {
        session_id: SessionId,
        path: PathBuf,
        summary: Option<String>,
    },
    /// A blocking question from the agent. `spec` is protocol.json-shaped
    /// (pick / multi / text / tier / confirm / card-with-input) and is deliberately
    /// opaque here: the frontend owns the widget for `spec.kind`, so a new question
    /// kind is a frontend registration and needs zero change in Rust.
    AskRequested {
        session_id: SessionId,
        qid: String,
        spec: Value,
    },
    /// The question closed — answered, timed out, or cancelled. The UI dismisses on this.
    AskResolved {
        session_id: SessionId,
        qid: String,
        answered: bool,
    },
    VisualRequested {
        session_id: SessionId,
        view: String,
        title: Option<String>,
        payload: Value,
    },
    TurnFinished {
        session_id: SessionId,
        success: bool,
        summary: Option<String>,
    },
    Error {
        session_id: Option<SessionId>,
        message: String,
    },
}

impl PanelEvent {
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::SessionStarted { session_id, .. }
            | Self::AgentText { session_id, .. }
            | Self::AgentStatus { session_id, .. }
            | Self::Activity { session_id, .. }
            | Self::FileChanged { session_id, .. }
            | Self::AskRequested { session_id, .. }
            | Self::AskResolved { session_id, .. }
            | Self::VisualRequested { session_id, .. }
            | Self::TurnFinished { session_id, .. } => Some(session_id),
            Self::Error { session_id, .. } => session_id.as_deref(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityState {
    Started,
    Finished,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn event_wire_format_is_stable_and_tagged() {
        let event = PanelEvent::VisualRequested {
            session_id: "session-1".into(),
            view: "progress".into(),
            title: Some("Running checks".into()),
            payload: json!({ "value": 65 }),
        };

        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["kind"], "visual_requested");
        assert_eq!(value["session_id"], "session-1");
        assert_eq!(value["payload"]["value"], 65);
    }

    #[test]
    fn errors_may_exist_before_a_session() {
        let event = PanelEvent::Error {
            session_id: None,
            message: "agent is not installed".into(),
        };
        assert_eq!(event.session_id(), None);
    }
}

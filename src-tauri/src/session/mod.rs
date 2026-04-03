pub mod persistence;
pub mod types;

use std::collections::HashMap;
use std::sync::Mutex;

use types::{Session, SessionSnapshot, SessionState};

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Session>>,
    tab_order: Mutex<Vec<String>>,
    active_tab: Mutex<Option<String>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tab_order: Mutex::new(Vec::new()),
            active_tab: Mutex::new(None),
        }
    }

    pub fn restore_from_snapshots(&self, snapshots: Vec<SessionSnapshot>) {
        let mut sessions = self.sessions.lock().unwrap();
        let mut order = self.tab_order.lock().unwrap();

        for snap in snapshots {
            let session = Session {
                id: snap.id.clone(),
                name: snap.name,
                config: snap.config,
                state: SessionState::Dead, // All restored sessions start as dead
                metadata: snap.metadata,
                created_at: snap.created_at,
                last_active: snap.last_active,
            };
            order.push(snap.id.clone());
            sessions.insert(snap.id, session);
        }
    }

    pub fn add_session(&self, session: Session) -> String {
        let id = session.id.clone();
        let mut sessions = self.sessions.lock().unwrap();
        let mut order = self.tab_order.lock().unwrap();
        let mut active = self.active_tab.lock().unwrap();

        sessions.insert(id.clone(), session);
        order.push(id.clone());
        *active = Some(id.clone());
        id
    }

    pub fn remove_session(&self, id: &str) -> Option<Session> {
        let mut sessions = self.sessions.lock().unwrap();
        let mut order = self.tab_order.lock().unwrap();
        let mut active = self.active_tab.lock().unwrap();

        order.retain(|x| x != id);

        if active.as_deref() == Some(id) {
            *active = order.last().cloned();
        }

        sessions.remove(id)
    }

    pub fn set_active(&self, id: &str) {
        let sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(id) {
            *self.active_tab.lock().unwrap() = Some(id.to_string());
        }
    }

    pub fn reorder_tabs(&self, new_order: Vec<String>) {
        *self.tab_order.lock().unwrap() = new_order;
    }

    pub fn list_sessions(&self) -> Vec<Session> {
        let sessions = self.sessions.lock().unwrap();
        let order = self.tab_order.lock().unwrap();
        order
            .iter()
            .filter_map(|id| sessions.get(id).cloned())
            .collect()
    }

}

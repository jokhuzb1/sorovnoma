const db = require('../database/db');

// In-memory wizard sessions
const wizardSessions = new Map();

module.exports = {
    // --- WIZARD SESSION ---
    getWizardSession: (userId) => wizardSessions.get(userId),
    updateWizardSession: (userId, data) => {
        const current = wizardSessions.get(userId) || {};
        wizardSessions.set(userId, { ...current, ...data });
    },
    clearWizardSession: (userId) => {
        wizardSessions.delete(userId);
    },

    // --- DRAFTS (Persistent) ---
    saveDraft: (userId, type, id) => {
        if (type === 'sticker') return;

        let draft = db.prepare('SELECT * FROM drafts WHERE user_id = ?').get(userId);
        if (!draft) {
            db.prepare('INSERT INTO drafts (user_id, media_type, media_id, updated_at) VALUES (?, ?, ?, ?)').run(userId, type, id, Date.now());
        } else {
            db.prepare('UPDATE drafts SET media_type = ?, media_id = ?, updated_at = ? WHERE user_id = ?').run(type, id, Date.now(), userId);
        }
    },
    getDraft: (userId) => {
        const draft = db.prepare('SELECT * FROM drafts WHERE user_id = ?').get(userId);
        if (!draft) return null;
        // Expire after 1 hour
        if (Date.now() - draft.updated_at > 1000 * 60 * 60) {
            db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
            return null;
        }
        if (draft.media_id) {
            return { type: draft.media_type, id: draft.media_id, timestamp: draft.updated_at };
        }
        return null;
    },
    clearDraft: (userId) => {
        db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
    }
};

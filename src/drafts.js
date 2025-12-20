// Database-backed draft storage (persistent across restarts)
const db = require('./database');

// Create drafts table if it doesn't exist
db.exec(`
    CREATE TABLE IF NOT EXISTS drafts (
        user_id INTEGER PRIMARY KEY,
        media_type TEXT,
        media_id TEXT,
        sticker_id TEXT,
        updated_at INTEGER
    )
`);

module.exports = {
    saveDraft: (userId, type, id) => {
        // Ignore stickers
        if (type === 'sticker') return;

        console.log(`[DRAFT] Saving ${type} for user ${userId}: ${id}`);

        // Get existing draft
        let draft = db.prepare('SELECT * FROM drafts WHERE user_id = ?').get(userId);

        if (!draft) {
            // Create new draft
            db.prepare('INSERT INTO drafts (user_id, media_type, media_id, updated_at) VALUES (?, ?, ?, ?)').run(userId, type, id, Date.now());
        } else {
            // Update existing draft
            db.prepare('UPDATE drafts SET media_type = ?, media_id = ?, updated_at = ? WHERE user_id = ?').run(type, id, Date.now(), userId);
        }

        console.log(`[DRAFT] Saved successfully`);
    },

    getDraft: (userId) => {
        const draft = db.prepare('SELECT * FROM drafts WHERE user_id = ?').get(userId);
        if (!draft) return null;

        // Check if expired (1 hour)
        if (Date.now() - draft.updated_at > 1000 * 60 * 60) {
            db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
            return null;
        }

        // Return media draft if exists
        if (draft.media_id) {
            return { type: draft.media_type, id: draft.media_id, timestamp: draft.updated_at };
        }

        return null;
    },

    // Legacy support: remove sticker methods or keep empty to prevent errors if called elsewhere (safeguard)
    getStickerDraft: (userId) => {
        return null;
    },

    getMediaDraft: (userId) => {
        const draft = db.prepare('SELECT * FROM drafts WHERE user_id = ?').get(userId);
        if (!draft || !draft.media_id) return null;

        // Check if expired (1 hour)
        if (Date.now() - draft.updated_at > 1000 * 60 * 60) {
            db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
            return null;
        }

        return { type: draft.media_type, id: draft.media_id, timestamp: draft.updated_at };
    },

    clearDraft: (userId) => {
        db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
    }
};

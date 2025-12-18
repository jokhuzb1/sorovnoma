// Simple In-Memory Cache for Draft Media
const draftMediaCache = new Map();

module.exports = {
    saveDraft: (userId, type, id) => {
        draftMediaCache.set(userId, { type, id, timestamp: Date.now() });
    },
    getDraft: (userId) => {
        const draft = draftMediaCache.get(userId);
        if (draft && Date.now() - draft.timestamp < 1000 * 60 * 60) { // 1 Hour TTL
            return draft;
        }
        return null; // Expired or none
    },
    clearDraft: (userId) => {
        draftMediaCache.delete(userId);
    }
};

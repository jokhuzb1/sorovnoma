const db = require('../database/db');

function executeVoteTransaction(pollId, userId, optionId, settings) {
    return db.transaction(() => {
        const existingVote = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ? AND option_id = ?').get(pollId, userId, optionId);
        const userVotes = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?').all(pollId, userId);

        let message = 'Ovoz qabul qilindi';

        if (existingVote) {
            // Remove Vote
            if (settings.allow_edit || settings.multiple_choice) {
                db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ? AND option_id = ?').run(pollId, userId, optionId);
                message = 'Ovoz olib tashlandi ↩️';
            } else {
                throw new Error('Ovozni ozgartira olmaysiz.');
            }
        } else {
            // Add Vote
            if (!settings.multiple_choice && userVotes.length > 0) {
                // Single choice, already voted
                if (settings.allow_edit) {
                    // Switch vote
                    db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId);
                    message = 'Ovoz ozgartirildi 🔄';
                } else {
                    throw new Error('Faqat bitta variant tanlash mumkin.');
                }
            }
            db.prepare('INSERT INTO votes (poll_id, user_id, option_id) VALUES (?, ?, ?)').run(pollId, userId, optionId);
        }
        return message;
    })();
}

module.exports = { executeVoteTransaction };

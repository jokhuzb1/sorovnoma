const db = require('../database/db');


function generatePollContent(pollId, botUsername) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return null;

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);
    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    let caption = `<b>${poll.description}</b>\n\n👇 <b>Ulashish uchun quyidagi tugmani bosing!</b>👇`;

    const inline_keyboard = options.map(opt => {
        const count = countsMap[opt.id] || 0;
        let text = opt.text;
        if (text.length > 40) {
            text = text.substring(0, 37) + '...';
        }
        return [{
            text: `(${count}) ${text}`,
            callback_data: `vote:${pollId}:${opt.id}`
        }];
    });

    if (poll.media_type && poll.media_type !== 'none') {
        inline_keyboard.unshift([
            { text: '⤴️ Ulashish', switch_inline_query: `poll_${pollId}` }
        ]);
    } else {
        caption = `<b>${poll.description}</b>`;
    }

    return { caption, reply_markup: { inline_keyboard }, poll };
}

function generateSharablePollContent(pollId, botUsername) {
    return generatePollContent(pollId, botUsername); // Reuse logic if identical, otherwise duplicate adaptation
}

function getPollResults(pollId) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return "Sorovnoma topilmadi.";

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId).count;
    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    let text = `📊 Sorovnoma Natijalari (#${pollId})\n\n`;
    text += `📝 ${poll.description.replace(/<[^>]*>/g, '')}\n\n`;

    // Create array with counts
    const results = options.map(opt => ({
        text: opt.text,
        count: countsMap[opt.id] || 0
    }));

    // Sort by count descending
    results.sort((a, b) => b.count - a.count);

    let rank = 0;
    let lastCount = -1;

    results.forEach(item => {
        if (item.count !== lastCount) {
            rank++;
            lastCount = item.count;
        }

        const percent = totalVotes > 0 ? ((item.count / totalVotes) * 100).toFixed(1) : 0;
        text += `${rank}. ${item.text}: ${item.count} ovoz (${percent}%)\n`;
    });

    text += `\n👥 Jami ovozlar: ${totalVotes}`;
    return text;
}

// Timeout cache for debouncing updates
const updateTimeouts = new Map();
let lastRateLimitLog = 0;

// --- GLOBAL UPDATE QUEUE ---
const UPDATE_QUEUE = [];
let isProcessingQueue = false;
const PROCESS_INTERVAL_MS = 40; // ~25 req/sec (Conservative limit)

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (UPDATE_QUEUE.length > 0) {
        const task = UPDATE_QUEUE.shift();
        try {
            await task();
        } catch (e) {
            // Suppress minor errors in queue
        }
        // Wait before next request
        await new Promise(r => setTimeout(r, PROCESS_INTERVAL_MS));
    }

    isProcessingQueue = false;
}

function queueUpdate(task) {
    UPDATE_QUEUE.push(task);
    processQueue();
}

async function updatePollMessage(bot, chatId, messageId, pollId, inlineMessageId = null, botUsername = null) {
    const content = generatePollContent(pollId, botUsername);
    if (!content) return;

    const { caption, reply_markup } = content;

    try {
        if (inlineMessageId) {
            await bot.editMessageCaption(caption, { inline_message_id: inlineMessageId, reply_markup, parse_mode: 'HTML' });
        } else if (chatId && messageId) {
            await bot.editMessageCaption(caption, { chat_id: chatId, message_id: messageId, reply_markup, parse_mode: 'HTML' });
        }
    } catch (e) {
        if (e.response && e.response.statusCode === 429) {
            const now = Date.now();
            if (now - lastRateLimitLog > 5000) {
                console.warn(`⚠️ Rate limit hit (429). Skipping UI updates to prevent crash. (Log suppressed for 5s)`);
                lastRateLimitLog = now;
            }
            return;
        }
        if (e.message.includes('there is no caption') || e.message.includes('message is not modified')) {
            if (e.message.includes('message is not modified')) return;
            try {
                if (inlineMessageId) {
                    await bot.editMessageText(caption, { inline_message_id: inlineMessageId, reply_markup, parse_mode: 'HTML' });
                } else if (chatId && messageId) {
                    await bot.editMessageText(caption, { chat_id: chatId, message_id: messageId, reply_markup, parse_mode: 'HTML' });
                }
            } catch (innerError) { /* ignore */ }
        }
    }
}

async function sendPoll(bot, chatId, pollId, botUsername) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return false;

    const content = generatePollContent(pollId, botUsername);
    if (!content) return false;

    const { caption, reply_markup } = content;

    try {
        let sentMsg;
        const opts = { caption, reply_markup, parse_mode: 'HTML' };

        if (poll.media_type === 'photo' && poll.media_id) {
            sentMsg = await bot.sendPhoto(chatId, poll.media_id, opts);
        } else if (poll.media_type === 'video' && poll.media_id) {
            sentMsg = await bot.sendVideo(chatId, poll.media_id, opts);
        } else {
            sentMsg = await bot.sendMessage(chatId, caption, { reply_markup, parse_mode: 'HTML' });
        }

        if (sentMsg) {
            db.prepare('INSERT OR IGNORE INTO poll_messages (poll_id, chat_id, message_id) VALUES (?, ?, ?)').run(pollId, chatId, sentMsg.message_id);
        }
        return true;
    } catch (e) {
        const err = e.message || '';
        if (err.includes('forbidden') || err.includes('blocked') || err.includes('chat not found') || err.includes('user is deactivated')) {
            // Expected delivery failures - suppress log
            return null;
        }
        console.error('Error sending poll:', err);
        return false;
    }
}

async function updateSharedPolls(bot, pollId, botUsername) {
    // Debounce Logic
    if (updateTimeouts.has(pollId)) {
        clearTimeout(updateTimeouts.get(pollId));
    }

    const timeoutId = setTimeout(async () => {
        updateTimeouts.delete(pollId);

        // Fetch targets
        const sharedInstances = db.prepare('SELECT inline_message_id FROM shared_polls WHERE poll_id = ?').all(pollId);
        const directMessages = db.prepare('SELECT chat_id, message_id FROM poll_messages WHERE poll_id = ?').all(pollId);

        if (sharedInstances.length === 0 && directMessages.length === 0) return;

        const content = generateSharablePollContent(pollId, botUsername);
        if (!content) return;

        // 1. Queue Inline Shared Instances
        for (const instance of sharedInstances) {
            queueUpdate(async () => {
                try {
                    await bot.editMessageCaption(content.caption, {
                        inline_message_id: instance.inline_message_id,
                        reply_markup: content.reply_markup,
                        parse_mode: 'HTML'
                    });
                } catch (e) {
                    if (e.message.includes('MESSAGE_ID_INVALID')) {
                        try { db.prepare('DELETE FROM shared_polls WHERE inline_message_id = ?').run(instance.inline_message_id); } catch (ex) { }
                    }
                }
            });
        }

        // 2. Queue Direct Messages
        for (const msg of directMessages) {
            queueUpdate(async () => {
                await updatePollMessage(bot, msg.chat_id, msg.message_id, pollId, null, botUsername)
                    .catch(e => {
                        if (e.message.includes('chat not found') || e.message.includes('forbidden') || e.message.includes('message to edit not found')) {
                            try { db.prepare('DELETE FROM poll_messages WHERE chat_id = ? AND message_id = ?').run(msg.chat_id, msg.message_id); } catch (ex) { }
                        }
                    });
            });
        }

    }, 2000); // 2 second debounce

    updateTimeouts.set(pollId, timeoutId);
}

function getCompactPollResults(pollId) {
    const totalVotesRaw = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId);
    const totalVotes = totalVotesRaw ? totalVotesRaw.count : 0;

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);
    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    // Sort by count descending
    options.sort((a, b) => (countsMap[b.id] || 0) - (countsMap[a.id] || 0));

    let text = "";
    options.forEach(opt => {
        const count = countsMap[opt.id] || 0;
        const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        // Truncate option text
        let shortText = opt.text.length > 15 ? opt.text.substring(0, 12) + "..." : opt.text;
        text += `${shortText}: ${count} (${percent}%)\n`;
    });
    text += `\nJami: ${totalVotes}`;
    return text;
}

async function sendSafeMessage(bot, chatId, text, options = {}) {
    queueUpdate(async () => {
        try {
            await bot.sendMessage(chatId, text, options);
        } catch (e) {
            // Ignore blocks/not started errors to prevent log spam
            const errLower = e.message.toLowerCase();
            if (!errLower.includes('forbidden') && !errLower.includes('chat not found') && !errLower.includes('bot was blocked')) {
                console.error(`SafeSend Error (${chatId}):`, e.message);
            }
        }
    });
}

module.exports = {
    generatePollContent,
    generateSharablePollContent,
    getPollResults,
    getCompactPollResults,
    sendPoll,
    updatePollMessage,
    updateSharedPolls,
    sendSafeMessage
};

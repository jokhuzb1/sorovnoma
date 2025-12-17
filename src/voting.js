
const db = require('./database');

async function checkChannelMembership(bot, userId, requiredChannels) {
    // Parallel Execution for Speed
    const results = await Promise.all(requiredChannels.map(async (channel) => {
        try {
            const member = await bot.getChatMember(channel, userId);
            if (!['creator', 'administrator', 'member'].includes(member.status)) {
                return channel;
            }
        } catch (error) {
            console.error(`Error checking membership for ${channel}: `, error.message);
            // If checking fails (e.g. bot not admin), treat as missing to be safe/strict
            // or maybe ignore? Let's treat as missing to prompt user.
            return channel;
        }
        return null; // Is member
    }));

    // Filter out nulls
    return results.filter(c => c !== null);
}

// Helper to generate Poll UI (Caption & Keyboard)
function generatePollContent(pollId) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return null;

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);

    // Optimized: Fetch all vote counts in ONE query
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId).count;

    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    console.log(`[DEBUG] Poll ${pollId} counts:`, voteCounts);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    const settings = JSON.parse(poll.settings_json || '{}');
    const mode = settings.multiple_choice ? 'Kop tanlov' : 'Bitta tanlov';

    let status = 'Ochiq';
    const now = new Date();
    if (poll.start_time && now < new Date(poll.start_time)) status = `Boshlanadi: ${new Date(poll.start_time).toLocaleString()}`;
    if (poll.end_time && now > new Date(poll.end_time)) status = 'Yopilgan 🔒';

    const caption = `${poll.description}\n\n📊 Jami ovozlar: ${totalVotes}\n⚙️ Rejim: ${mode}\n🕒 Holat: ${status}`;

    const inline_keyboard = options.map(opt => [{
        text: `${opt.text} (${countsMap[opt.id] || 0})`,
        callback_data: `vote:${pollId}:${opt.id}`
    }]);

    // Add Share Button
    inline_keyboard.push([{ text: '♻️ Ulashish', switch_inline_query: `poll_${pollId}` }]);

    return { caption, reply_markup: { inline_keyboard }, poll };
}

const updateQueue = new Map();

// Process Queue every 2 seconds
setInterval(async () => {
    if (updateQueue.size === 0) return;

    const updates = Array.from(updateQueue.values());
    updateQueue.clear();

    console.log(`[BATCH] Processing ${updates.length} UI updates...`);

    for (const update of updates) {
        await updatePollMessage(update.bot, update.chatId, update.messageId, update.pollId, update.inlineMessageId);
    }
}, 2000);

const processingCache = new Set();

async function handleVote(bot, query, botUsername) {
    const { id, data, message, from, inline_message_id } = query;
    const userId = from.id;

    // Input Debouncing: Ignore clicks from same user on same data within 1 second
    const uniqueKey = `${userId}:${data}`;
    if (processingCache.has(uniqueKey)) {
        return bot.answerCallbackQuery(id); // Silent ignore
    }
    processingCache.add(uniqueKey);
    setTimeout(() => processingCache.delete(uniqueKey), 1000);

    // console.log(`[VOTE] User ${userId} clicked: ${data}`); // Reduced log spam

    try {
        const [type, pollId, optionId] = data.split(':');

        if (type !== 'vote') return;

        const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
        if (!poll) return bot.answerCallbackQuery(id, { text: 'Sorovnoma topilmadi!' });

        const settings = JSON.parse(poll.settings_json || '{}');
        const requiredChannels = db.prepare('SELECT channel_username FROM required_channels WHERE poll_id = ?').all(pollId).map(r => r.channel_username);

        // Gatekeeping with Redirect
        if (requiredChannels.length > 0) {
            const SUPER_ADMINS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10));

            if (!SUPER_ADMINS.includes(userId)) {
                const missing = await checkChannelMembership(bot, userId, requiredChannels);
                if (missing.length > 0) {
                    if (botUsername) {
                        return bot.answerCallbackQuery(id, {
                            url: `https://t.me/${botUsername}?start=verify_${pollId}`,
                            cache_time: 0
                        });
                    } else {
                        return bot.answerCallbackQuery(id, {
                            text: `Ovoz berish uchun ${missing.join(', ')} kanallariga azo bolishingiz kerak!`,
                            show_alert: true
                        });
                    }
                }
            }
        }

        // Time Validation
        const now = new Date();
        const start = poll.start_time ? new Date(poll.start_time) : null;
        const end = poll.end_time ? new Date(poll.end_time) : null;

        if (start && now < start) {
            return bot.answerCallbackQuery(id, { text: `⏳ Sorovnoma ${Math.ceil((start - now) / 60000)} daqiqadan keyin boshlanadi.`, show_alert: true });
        }
        if (end && now > end) {
            return bot.answerCallbackQuery(id, { text: '🔒 Sorovnoma yopilgan.', show_alert: true });
        }

        // Vote Logic
        const existingVote = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ? AND option_id = ?').get(pollId, userId, optionId);
        const userVotes = db.prepare('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?').all(pollId, userId);

        let successMessage = 'Ovoz berildi!';

        if (existingVote) {
            if (settings.allow_edit || settings.multiple_choice) {
                db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ? AND option_id = ?').run(pollId, userId, optionId);
                successMessage = 'Ovoz olib tashlandi.';
            } else {
                return bot.answerCallbackQuery(id, { text: 'Ovozni ozgartira olmaysiz.' });
            }
        } else {
            if (!settings.multiple_choice && userVotes.length > 0) {
                if (settings.allow_edit) {
                    const deleteStmt = db.prepare('DELETE FROM votes WHERE poll_id = ? AND user_id = ?');
                    deleteStmt.run(pollId, userId);
                } else {
                    return bot.answerCallbackQuery(id, { text: 'Kop tanlov ochirilgan.' });
                }
            }
            db.prepare('INSERT INTO votes (poll_id, user_id, option_id) VALUES (?, ?, ?)').run(pollId, userId, optionId);
        }

        // Optimistic UI Feedback (Immediate Toast)
        await bot.answerCallbackQuery(id, { text: successMessage });

        // Queue UI Update (Batching)
        const chatId = message ? message.chat.id : null;
        const messageId = message ? message.message_id : null;
        const key = inline_message_id ? `inline:${inline_message_id}` : `${chatId}:${messageId}`;

        if (!updateQueue.has(key)) {
            updateQueue.set(key, { bot, chatId, messageId, pollId, inlineMessageId: inline_message_id });
        }

    } catch (error) {
        console.error('Vote Error:', error);
        try {
            bot.answerCallbackQuery(id, { text: 'Error!' });
        } catch (e) { }
    }
}

async function updatePollMessage(bot, chatId, messageId, pollId, inlineMessageId = null) {
    const content = generatePollContent(pollId);
    if (!content) return;

    const { caption, reply_markup } = content;

    try {
        if (inlineMessageId) {
            await bot.editMessageCaption(caption, { inline_message_id: inlineMessageId, reply_markup });
        } else if (chatId && messageId) {
            await bot.editMessageCaption(caption, { chat_id: chatId, message_id: messageId, reply_markup });
        }
    } catch (e) {
        // Fallback for text messages
        if (e.message.includes('there is no caption') || e.message.includes('message is not modified')) {
            if (e.message.includes('message is not modified')) return; // Ignore "not modified" errors

            try {
                if (inlineMessageId) {
                    await bot.editMessageText(caption, { inline_message_id: inlineMessageId, reply_markup });
                } else if (chatId && messageId) {
                    await bot.editMessageText(caption, { chat_id: chatId, message_id: messageId, reply_markup });
                }
            } catch (innerError) {
                // Ignore
            }
        }
    }
}

async function sendPoll(bot, chatId, pollId) {
    const content = generatePollContent(pollId);
    if (!content) return false;

    const { caption, reply_markup, poll } = content;

    try {
        if (poll.media_type === 'photo') {
            await bot.sendPhoto(chatId, poll.media_id, { caption, reply_markup });
        } else if (poll.media_type === 'video') {
            await bot.sendVideo(chatId, poll.media_id, { caption, reply_markup });
        } else {
            await bot.sendMessage(chatId, caption, { reply_markup });
        }
        return true;
    } catch (e) {
        console.error('Error sending poll:', e.message);
        return false;
    }
}

module.exports = { handleVote, updatePollMessage, sendPoll, generatePollContent, checkChannelMembership };

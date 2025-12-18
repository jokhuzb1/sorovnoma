const db = require('./database');

// --- CACHE SETUP ---
const membershipCache = new Map();
const SUCCESS_TTL = 5 * 60 * 1000; // 5 Minutes for Members
const FAILURE_TTL = 2 * 1000;      // 2 Seconds for Non-Members (Instant Retry)

function getCachedMembership(userId, channel) {
    const key = `${userId}:${channel}`;
    const cached = membershipCache.get(key);
    if (cached && Date.now() < cached.expiry) {
        return cached.isMember;
    }
    return null;
}

function setCachedMembership(userId, channel, isMember) {
    const key = `${userId}:${channel}`;
    const ttl = isMember ? SUCCESS_TTL : FAILURE_TTL;
    membershipCache.set(key, { isMember, expiry: Date.now() + ttl });
}

// Cleanup Cache periodically (every 10 mins)
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of membershipCache.entries()) {
        if (now > value.expiry) membershipCache.delete(key);
    }
}, 10 * 60 * 1000);
// -------------------

async function checkChannelMembership(bot, userId, requiredChannels) {
    // Parallel Execution with Caching
    const results = await Promise.all(requiredChannels.map(async (channel) => {
        // 1. Check Cache
        const cached = getCachedMembership(userId, channel);
        if (cached !== null) {
            return cached ? null : channel; // If member, return null (success), else return channel (missing)
        }

        // 2. Fetch from API
        try {
            const member = await bot.getChatMember(channel, userId);
            const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);

            // Update Cache
            setCachedMembership(userId, channel, isMember);

            if (!isMember) return channel;
        } catch (error) {
            console.error(`Error checking membership for ${channel}: `, error.message);
            // On error (e.g. bot kicked), treat as NOT member to be safe
            return channel;
        }
        return null; // Is member
    }));

    // Filter out nulls (meaning they ARE members) to leave only MISSING channels
    return results.filter(c => c !== null);
}

// Helper to generate Poll UI
function generatePollContent(pollId) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return null;

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);

    // Optimized: Fetch all vote counts in ONE query
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId).count;

    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
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

    // Add Share Button AND Refresh Button
    inline_keyboard.push([
        { text: '♻️ Ulashish', switch_inline_query: `poll_${pollId}` },
        { text: '🔄 Yangilash', callback_data: `refresh:${pollId}` }
    ]);

    return { caption, reply_markup: { inline_keyboard }, poll };
}

const updateQueue = new Map();

// Process Queue Instantly or Very Fast (200ms)
setInterval(async () => {
    if (updateQueue.size === 0) return;

    // Snapshot current updates and clear queue immediately to allow new ones
    const updates = Array.from(updateQueue.values());
    updateQueue.clear();

    const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));
    const batches = chunk(updates, 10); // Higher concurrency: 10

    for (const batch of batches) {
        await Promise.all(batch.map(u =>
            updatePollMessage(u.bot, u.chatId, u.messageId, u.pollId, u.inlineMessageId)
                .catch(e => console.error('Update Failed:', e.message))
        ));
    }

}, 200);

const processingCache = new Set();
const throttleTime = 200; // 200ms: Bare minimum to prevent accidental double-clicks

async function handleVote(bot, query, botUsername) {
    const { id, from, data, message, inline_message_id } = query;
    const userId = from.id;

    const [_, strPollId] = data.split(':'); // Extract pollId string for throttling

    // Throttle per User per Poll to allow voting on different polls
    const throttleKey = `${userId}:${strPollId}`;

    if (processingCache.has(throttleKey)) {
        // Silent ignore or toast
        return bot.answerCallbackQuery(id); // Silent
    }
    processingCache.add(throttleKey);
    setTimeout(() => processingCache.delete(throttleKey), throttleTime); // 1 Second throttle

    try {
        const [type, pollIdStr, optionIdStr] = data.split(':');
        /* FORCE INT */
        const pollId = parseInt(pollIdStr, 10);
        const optionId = parseInt(optionIdStr, 10);

        // HANDLE REFRESH
        if (type === 'refresh') {
            await handleRefresh(bot, message, pollId, inline_message_id);
            return bot.answerCallbackQuery(id, { text: '🔄 Yangilandi' });
        }

        if (type !== 'vote') return bot.answerCallbackQuery(id); // Just close for non-votes

        // console.log(`[Vote] User: ${userId}, Poll: ${pollId}, Option: ${optionId}`);

        const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);

        if (!poll) {
            return bot.answerCallbackQuery(id, { text: '❌ Sorovnoma topilmadi (ochirilgan bolishi mumkin).', show_alert: true });
        }

        const settings = JSON.parse(poll.settings_json || '{}');
        const requiredChannels = db.prepare('SELECT channel_username FROM required_channels WHERE poll_id = ?').all(pollId).map(r => r.channel_username);

        // console.log(`[Vote] Required Channels: ${requiredChannels.join(', ')}`);

        // Gatekeeping Check (Async - outside transaction)
        if (requiredChannels.length > 0) {
            const SUPER_ADMINS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10));

            if (!SUPER_ADMINS.includes(userId)) {
                // Check membership (Fast with Cache)
                const missing = await checkChannelMembership(bot, userId, requiredChannels);
                console.log(`[Vote] User: ${userId}, Missing: ${missing.length > 0 ? missing.join(', ') : 'None'}`);

                if (missing.length > 0) {
                    if (botUsername) {
                        try {
                            const redirectUrl = `https://t.me/${botUsername}?start=verify_${pollId}`;
                            // console.log(`[Vote] Redirecting ${userId} to ${redirectUrl}`);

                            await bot.answerCallbackQuery(id, {
                                url: redirectUrl,
                                cache_time: 0
                            });
                            return;
                        } catch (e) {
                            console.error(`[Vote] Redirect Failed for ${userId}:`, e.message);

                            // Last Resort Fallback: Just tell them nicely
                            await bot.answerCallbackQuery(id, {
                                text: `⚠️ Ovoz berish uchun kanallarga obuna bo'ling!`,
                                show_alert: true,
                                cache_time: 0
                            });
                            return;
                        }
                    } else {
                        console.error('[Vote] Bot Username missing!');
                        await bot.answerCallbackQuery(id, {
                            text: `⚠️ Iltimos, kanalga obuna bo'ling.`,
                            show_alert: true
                        });
                        return;
                    }
                }
            }

            // Time Check
            const now = new Date();
            const start = poll.start_time ? new Date(poll.start_time) : null;
            const end = poll.end_time ? new Date(poll.end_time) : null;

            if (start && now < start) {
                return bot.answerCallbackQuery(id, { text: `⏳ Sorovnoma ${Math.ceil((start - now) / 60000)} daqiqadan keyin boshlanadi.`, show_alert: true });
            }
            if (end && now > end) {
                return bot.answerCallbackQuery(id, { text: '🔒 Sorovnoma yopilgan.', show_alert: true });
            }

            // --- TRANSACTIONAL VOTING LOGIC ---
            // We define the transaction
            const executeVoteTransaction = db.transaction(() => {
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
            });

            // Execute Transaction
            let successMessage;
            try {
                successMessage = executeVoteTransaction();
            } catch (txError) {
                // Logic errors inside transaction (like "can't edit")
                return bot.answerCallbackQuery(id, { text: txError.message, show_alert: true });
            }

            // Send Success Toast
            bot.answerCallbackQuery(id, { text: successMessage });

            // Queue UI Update
            const chatId = message ? message.chat.id : null;
            const messageId = message ? message.message_id : null;
            const key = inline_message_id ? `inline:${inline_message_id}` : `${chatId}:${messageId}`;

            if (!updateQueue.has(key)) {
                updateQueue.set(key, { bot, chatId, messageId, pollId, inlineMessageId: inline_message_id });
            }

        } catch (error) {
            console.error('Vote Error:', error);
            try { bot.answerCallbackQuery(id, { text: 'Xatolik yuz berdi' }); } catch (e) { }
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
                if (e.message.includes('message is not modified')) return;

                try {
                    if (inlineMessageId) {
                        await bot.editMessageText(caption, { inline_message_id: inlineMessageId, reply_markup });
                    } else if (chatId && messageId) {
                        await bot.editMessageText(caption, { chat_id: chatId, message_id: messageId, reply_markup });
                    }
                } catch (innerError) { /* ignore */ }
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

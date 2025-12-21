const db = require('./database');

// NO CACHING - STRICT CHECK
async function checkChannelMembership(bot, userId, requiredChannels) {
    // Parallelize checks to prevent "query is too old" timeouts
    const checks = requiredChannels.map(async (channel) => {
        const target = channel.channel_id || channel.channel_username;
        const title = channel.channel_title || channel.channel_username;

        try {
            console.log(`[channel_check] Checking ${target} for ${userId}...`);
            const member = await bot.getChatMember(target, userId);
            console.log(`[channel_check] Result for ${target}: ${member.status}`);

            if (!['creator', 'administrator', 'member'].includes(member.status)) {
                // Return Title Priority: Saved Title -> API Title -> Username
                const displayTitle = channel.channel_title || title || channel.channel_username;
                return { id: target, title: displayTitle, url: channel.channel_username ? `https://t.me/${channel.channel_username.replace('@', '')}` : null };
            }
        } catch (e) {
            console.error(`[channel_check] Error checking ${target}: ${e.message}`);
            const displayTitle = channel.channel_title || title;
            // Check for specific Bot Permissions errors
            if (e.message.includes('bot is not a member') || e.message.includes('user not found')) {
                return { id: target, title: displayTitle, error: `Bot ${displayTitle} kanalida admin emas!` };
            }
            if (e.message.includes('chat not found')) {
                return { id: target, title: displayTitle, error: `Kanal topilmadi: ${displayTitle}` };
            }
            // General error
            return { id: target, title: title, error: `Xatolik: ${e.message}` };
        }
        return null;
    });

    const results = await Promise.all(checks);
    return results.filter(r => r !== null);
}

// Helper to generate Poll UI
function generatePollContent(pollId, botUsername) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return null;

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);

    // Optimized: Fetch all vote counts in ONE query
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId).count;

    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    // Caption: Descripton + Bold Instruction (No Link)
    let caption = `<b>${poll.description}</b>\n\n👇 <b>Ulashish uchun quyidagi tugmani bosing!</b>👇`;

    // Show vote counts in buttons (Text + Count only)
    const inline_keyboard = options.map(opt => {
        const count = countsMap[opt.id] || 0;
        return [{
            text: `${opt.text} (${count})`,
            callback_data: `vote:${pollId}:${opt.id}`
        }];
    });

    // Share button at the TOP (Only if Media exists)
    if (poll.media_type && poll.media_type !== 'none') {
        inline_keyboard.unshift([
            { text: '⤴️ Ulashish', switch_inline_query: `poll_${pollId}` }
        ]);
    } else {
        // If no share button, maybe remove the "Ulashish uchun" text?
        // User said "make sharing not possible if they do not select the photo".
        // So for text polls, we just don't show the share UI.
        caption = `<b>${poll.description}</b>`;
    }

    return { caption, reply_markup: { inline_keyboard }, poll };
}

// Helper to generate SHARABLE Poll Content (WITH BUTTONS)
function generateSharablePollContent(pollId, botUsername) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return null;

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);

    // Optimized: Fetch all vote counts in ONE query
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId).count;
    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    // Caption: Descripton + Bold Instruction (No Link)
    let caption = `<b>${poll.description}</b>\n\n👇 <b>Ulashish uchun quyidagi tugmani bosing!</b>👇`;

    // Show vote counts in buttons (Text + Count only)
    const inline_keyboard = options.map(opt => {
        const count = countsMap[opt.id] || 0;
        return [{
            text: `${opt.text} (${count})`,
            callback_data: `vote:${pollId}:${opt.id}`
        }];
    });

    // Share button at the TOP (Only if Media exists)
    if (poll.media_type && poll.media_type !== 'none') {
        inline_keyboard.unshift([
            { text: '⤴️ Ulashish', switch_inline_query: `poll_${pollId}` }
        ]);
    } else {
        caption = `<b>${poll.description}</b>`;
    }

    return { caption, reply_markup: { inline_keyboard }, poll };
}

// Helper to generate "Join Bot" version of poll for unverified users
function generateJoinBotPoll(pollId, botUsername) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return null;

    // Simple caption without status
    let caption = `${poll.description}`;

    const startBotUrl = `https://t.me/${botUsername}?start=verify_${pollId}`;
    const inline_keyboard = [
        [{ text: '🤖 Kanallarga Qo\'shilish (Botni Boshlash)', url: startBotUrl }],
        [{ text: '✅ Obuna bo\'ldim', callback_data: `check_sub:${pollId}` }]
    ];

    return { caption, reply_markup: { inline_keyboard }, poll };
}

async function sendPoll(bot, chatId, pollId, botUsername) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return false;

    // Use button-based poll INSIDE BOT
    const content = generatePollContent(pollId, botUsername);
    if (!content) return false;

    const { caption, reply_markup } = content;

    try {
        let sentMsg;
        const opts = { caption, reply_markup, parse_mode: 'HTML' }; // Added parse_mode

        if (poll.media_type === 'photo' && poll.media_id) {
            sentMsg = await bot.sendPhoto(chatId, poll.media_id, opts);
        } else if (poll.media_type === 'video' && poll.media_id) {
            sentMsg = await bot.sendVideo(chatId, poll.media_id, opts);
        } else {
            sentMsg = await bot.sendMessage(chatId, caption, opts);
        }

        if (sentMsg) {
            try {
                // Determine if it's a channel/group/private for logging
                const type = chatId < 0 ? 'Group/Channel' : 'Private';
                db.prepare('INSERT OR IGNORE INTO poll_messages (poll_id, chat_id, message_id) VALUES (?, ?, ?)').run(pollId, chatId, sentMsg.message_id);
                console.log(`[sendPoll] Tracked ${type} message: ${chatId}:${sentMsg.message_id} for Poll #${pollId}`);
            } catch (dbErr) {
                console.error('Failed to track poll message:', dbErr.message);
            }
        }
        return true;
    } catch (e) {
        console.error('Error sending poll:', e.message);
        return false;
    }
}

const updateQueue = new Map();

// Helper to generate text results
function getPollResults(pollId) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return "Sorovnoma topilmadi.";

    const options = db.prepare('SELECT * FROM options WHERE poll_id = ?').all(pollId);
    const totalVotes = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM votes WHERE poll_id = ?').get(pollId).count;
    const voteCounts = db.prepare('SELECT option_id, COUNT(*) as count FROM votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const countsMap = {};
    voteCounts.forEach(row => countsMap[row.option_id] = row.count);

    let text = `📊 **Sorovnoma Natijalari** (#${pollId})\n\n`;
    text += `📝 ${poll.description}\n\n`;

    options.forEach(opt => {
        const count = countsMap[opt.id] || 0;
        const percent = totalVotes > 0 ? ((count / totalVotes) * 100).toFixed(1) : 0;
        text += `▫️ ${opt.text}: **${count}** ovoz (${percent}%)\n`;
    });

    text += `\n👥 Jami ovozlar: ${totalVotes}`;
    return text;
}

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
            updatePollMessage(u.bot, u.chatId, u.messageId, u.pollId, u.inlineMessageId, u.botUsername)
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

        // ------------------ RESULTS HANDLER ------------------
        if (type === 'results') {
            const SUPER_ADMINS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10));

            // Check if user is Admin or Super Admin
            let isAdmin = SUPER_ADMINS.includes(userId);
            if (!isAdmin) {
                const adminEntry = db.prepare('SELECT 1 FROM admins WHERE user_id = ?').get(userId);
                if (adminEntry) isAdmin = true;
            }

            if (!isAdmin) {
                return bot.answerCallbackQuery(id, { text: '⛔ Faqat adminlar korishi mumkin.', show_alert: true });
            }

            const resultsText = getPollResults(pollId);
            return bot.answerCallbackQuery(id, { text: resultsText, show_alert: true });
        }
        // ----------------------------------------------------

        const optionId = parseInt(optionIdStr, 10);

        // IMPLEMENT HANDLE REFRESH LOCALLY
        const handleRefresh = async (bot, message, pollId, inline_message_id) => {
            const chatId = message ? message.chat.id : null;
            const messageId = message ? message.message_id : null;
            await updatePollMessage(bot, chatId, messageId, pollId, inline_message_id);
        };

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
        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);

        // Gatekeeping Check (Async - outside transaction)
        if (requiredChannels.length > 0) {
            const SUPER_ADMINS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10));

            if (!SUPER_ADMINS.includes(userId)) {
                // Check membership immediately (no initial callback answer - we'll answer with redirect or error)

                // Check membership (Strict, No Cache)
                const missing = await checkChannelMembership(bot, userId, requiredChannels);
                console.log(`[DEBUG] Missing channels for user ${userId}:`, missing.length);

                if (missing.length > 0) {
                    // Check if any error exists
                    const errors = missing.filter(m => m.error);
                    if (errors.length > 0) {
                        console.log(`[DEBUG] Channel check errors:`, errors);
                        // Show technical error to user instead of loop
                        const errorMsg = errors.map(e => `⚠️ ${e.error}`).join('\n');
                        return bot.answerCallbackQuery(id, {
                            text: `BOT SOZLAMALARIDA XATOLIK:\n\n${errorMsg}\n\nAdmin bilan bog'laning.`,
                            show_alert: true
                        });
                    }


                    // FIX: REDIRECT TO BOT FOR VERIFICATION
                    // Do NOT edit the shared message buttons, as that affects everyone.
                    // Instead, redirect the specific user to the bot to handle verification privately.

                    console.log(`[DEBUG] User ${userId} not verified. Redirecting to bot...`);

                    // Save Return Link Context (Optional, for deep linking back if needed)
                    // Save Return Link Context
                    if (message && message.chat) {
                        if (message.chat.username) {
                            // Public Chat
                            returnLinkMap.set(userId, `https://t.me/${message.chat.username}/${message.message_id}`);
                        } else if (message.chat.id.toString().startsWith('-100')) {
                            // Private Supergroup (convert -100123... to 123...)
                            const chatIdStr = message.chat.id.toString();
                            const cleanId = chatIdStr.substring(4); // Remove -100
                            returnLinkMap.set(userId, `https://t.me/c/${cleanId}/${message.message_id}`);
                        }
                    }

                    const startBotUrl = `https://t.me/${botUsername}?start=verify_${pollId}`;

                    try {
                        // Attempt to open the bot via URL
                        await bot.answerCallbackQuery(id, {
                            url: startBotUrl
                        });
                    } catch (e) {
                        // Fallback
                        await bot.answerCallbackQuery(id, {
                            text: '⚠️ Avval kanallarga a\'zo bo\'ling! (Botni start qiling)',
                            show_alert: true
                        });
                    }
                    return; // Stop here
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

        // Send Success Toast Notification (not blocking alert)
        bot.answerCallbackQuery(id, { text: `✅ ${successMessage}`, show_alert: true });

        // Queue UI Update (for bot messages)
        const chatId = message ? message.chat.id : null;
        const messageId = message ? message.message_id : null;
        const key = inline_message_id ? `inline:${inline_message_id}` : `${chatId}:${messageId}`;

        if (!updateQueue.has(key)) {
            updateQueue.set(key, { bot, chatId, messageId, pollId, inlineMessageId: inline_message_id, botUsername });
        }

        // Trigger shared poll updates (passed from index.js)
        if (typeof global.updateSharedPolls === 'function') {
            global.updateSharedPolls(pollId);
        }

    } catch (error) {
        console.error('Vote Error:', error);
        try { bot.answerCallbackQuery(id, { text: 'Xatolik yuz berdi' }); } catch (e) { }
    }
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
        // Fallback for text messages or when caption edit fails
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

    // Use button-based poll INSIDE BOT
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
            // For sendMessage, third arg is options. 'caption' is not valid for sendMessage, text is first arg.
            // But we must pass parse_mode in options.
            sentMsg = await bot.sendMessage(chatId, caption, { reply_markup, parse_mode: 'HTML' });
        }

        if (sentMsg) {
            try {
                // Determine if it's a channel/group/private for logging
                const type = chatId < 0 ? 'Group/Channel' : 'Private';
                db.prepare('INSERT OR IGNORE INTO poll_messages (poll_id, chat_id, message_id) VALUES (?, ?, ?)').run(pollId, chatId, sentMsg.message_id);
                console.log(`[sendPoll] Tracked ${type} message: ${chatId}:${sentMsg.message_id} for Poll #${pollId}`);
            } catch (dbErr) {
                console.error('Failed to track poll message:', dbErr.message);
            }
        }
        return true;
    } catch (e) {
        console.error('Error sending poll:', e.message);
        return false;
    }
}

const returnLinkMap = new Map();

module.exports = { handleVote, updatePollMessage, sendPoll, generatePollContent, generateSharablePollContent, checkChannelMembership, returnLinkMap, getPollResults };

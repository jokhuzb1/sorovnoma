const db = require('../database/db');
const { executeVoteTransaction } = require('../services/voteService');
const { updatePollMessage, updateSharedPolls, getPollResults } = require('../services/pollService');
const { checkChannelMembership } = require('../services/channelService');

const updateQueue = new Map();

// Update Looper
setInterval(async () => {
    if (updateQueue.size === 0) return;
    const updates = Array.from(updateQueue.values());
    updateQueue.clear();
    const batches = ((arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size)))(updates, 10);

    for (const batch of batches) {
        await Promise.all(batch.map(u =>
            updatePollMessage(u.bot, u.chatId, u.messageId, u.pollId, u.inlineMessageId, u.botUsername)
                .catch(e => console.error('Update Failed:', e.message))
        ));
    }
}, 200);

const processingCache = new Set();
const throttleTime = 200;

async function handleVote(bot, query, botUsername) {
    const { id, from, data, message, inline_message_id } = query;
    const userId = from.id;
    const [type, strPollId, optionIdStr] = data.split(':');

    // Results
    if (type === 'results') {
        const resultsText = getPollResults(parseInt(strPollId));
        return bot.answerCallbackQuery(id, { text: resultsText, show_alert: true });
    }

    // Check Subscription Callback
    if (type === 'check_sub') {
        const pollId = parseInt(strPollId, 10);
        const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
        if (!poll) return bot.answerCallbackQuery(id, { text: '❌ Sorovnoma topilmadi.', show_alert: true });

        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
        const { checkChannelMembership } = require('../services/channelService');
        const missing = await checkChannelMembership(bot, userId, requiredChannels);

        if (missing.length > 0) {
            return bot.answerCallbackQuery(id, { text: '⚠️ Hali ham barcha kanallarga a\'zo bo\'lmadingiz!', show_alert: true });
        }

        await bot.answerCallbackQuery(id, { text: '✅ Muvaffaqiyatli! Ovoz berishingiz mumkin.' });
        const { sendPoll } = require('../services/pollService');

        // Delete the "Please join" message if possible and send poll, or just send poll
        try {
            await bot.deleteMessage(message.chat.id, message.message_id);
        } catch (e) { }

        return sendPoll(bot, message.chat.id, pollId, botUsername);
    }

    if (type !== 'vote') return bot.answerCallbackQuery(id); // Ignored

    // Throttle
    const throttleKey = `${userId}:${strPollId}`;
    if (processingCache.has(throttleKey)) return bot.answerCallbackQuery(id);
    processingCache.add(throttleKey);
    setTimeout(() => processingCache.delete(throttleKey), throttleTime);

    try {
        const pollId = parseInt(strPollId, 10);
        const optionId = parseInt(optionIdStr, 10);
        const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);

        if (!poll) return bot.answerCallbackQuery(id, { text: '❌ Sorovnoma topilmadi.', show_alert: true });

        // Channel Check
        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
        if (requiredChannels.length > 0) {
            const missing = await checkChannelMembership(bot, userId, requiredChannels);
            if (missing.length > 0) {
                const startBotUrl = `https://t.me/${botUsername}?start=verify_${pollId}`;
                try {
                    await bot.answerCallbackQuery(id, { url: startBotUrl });
                } catch (e) {
                    await bot.answerCallbackQuery(id, { text: '⚠️ Kanallarga a\'zo bo\'ling!', show_alert: true });
                }
                return;
            }
        }

        // Time Check
        const now = new Date();
        if (poll.start_time && now < new Date(poll.start_time)) return bot.answerCallbackQuery(id, { text: '⏳ Hali boshlanmadi.', show_alert: true });
        if (poll.end_time && now > new Date(poll.end_time)) return bot.answerCallbackQuery(id, { text: '🔒 Yopiq.', show_alert: true });

        // Vote
        const settings = JSON.parse(poll.settings_json || '{}');
        let msg = executeVoteTransaction(pollId, userId, optionId, settings);

        bot.answerCallbackQuery(id, { text: `✅ ${msg}`, show_alert: false });

        // Queue Updates
        const chatId = message ? message.chat.id : null;
        const messageId = message ? message.message_id : null;
        const key = inline_message_id ? `inline:${inline_message_id}` : `${chatId}:${messageId}`;

        if (!updateQueue.has(key)) {
            updateQueue.set(key, { bot, chatId, messageId, pollId, inlineMessageId: inline_message_id, botUsername });
        }

        await updateSharedPolls(bot, pollId, botUsername);

    } catch (e) {
        // Don't log expected logic errors to console, just show to user
        const knownErrors = ['Ovozni ozgartira olmaysiz.', 'Faqat bitta variant tanlash mumkin.'];
        if (!knownErrors.includes(e.message)) {
            console.error('Vote Error:', e);
        }
        bot.answerCallbackQuery(id, { text: e.message, show_alert: true });
    }
}

module.exports = { handleVote };

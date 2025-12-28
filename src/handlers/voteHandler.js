const db = require('../database/db');
const { executeVoteTransaction } = require('../services/voteService');
const { updatePollMessage, updateSharedPolls, getPollResults, getCompactPollResults, sendSafeMessage } = require('../services/pollService');
const { checkChannelMembership } = require('../services/channelService');

const processingCache = new Set();
const throttleTime = 200;

async function handleVote(bot, query, botUsername) {
    const { id, from, data, message, inline_message_id } = query;
    const userId = from.id;
    const [type, strPollId, optionIdStr] = data.split(':');

    // Results
    if (type === 'results') {
        const resultsText = getPollResults(parseInt(strPollId));
        return bot.answerCallbackQuery(id, { text: resultsText, show_alert: true }).catch(() => { });
    }

    // Check Subscription Callback
    if (type === 'check_sub') {
        const pollId = parseInt(strPollId, 10);
        const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
        if (!poll) return bot.answerCallbackQuery(id, { text: '❌ Sorovnoma topilmadi.', show_alert: true }).catch(() => { });

        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
        const { checkChannelMembership } = require('../services/channelService');
        const missing = await checkChannelMembership(bot, userId, requiredChannels);

        if (missing.length > 0) {
            return bot.answerCallbackQuery(id, { text: '⚠️ Hali ham barcha kanallarga a\'zo bo\'lmadingiz!', show_alert: true }).catch(() => { });
        }

        await bot.answerCallbackQuery(id, { text: '✅ Muvaffaqiyatli! Ovoz berishingiz mumkin.' }).catch(() => { });
        const { sendPoll } = require('../services/pollService');

        // Delete the "Please join" message if possible and send poll, or just send poll
        try {
            await bot.deleteMessage(message.chat.id, message.message_id);
        } catch (e) { }

        return sendPoll(bot, message.chat.id, pollId, botUsername);
    }

    if (type !== 'vote') return bot.answerCallbackQuery(id).catch(() => { }); // Ignored

    // Throttle
    const throttleKey = `${userId}:${strPollId}`;
    if (processingCache.has(throttleKey)) return bot.answerCallbackQuery(id).catch(() => { });
    processingCache.add(throttleKey);
    setTimeout(() => processingCache.delete(throttleKey), throttleTime);

    // Capture User Info if missing
    try {
        const { saveUser } = require('./messageHandler');
        saveUser(from);
    } catch (e) { }

    try {
        const pollId = parseInt(strPollId, 10);
        const optionId = parseInt(optionIdStr, 10);
        const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);

        if (!poll) return bot.answerCallbackQuery(id, { text: '🚫 Kechirasiz, ushbu so\'rovnoma topilmadi yoki o\'chirilgan.', show_alert: true }).catch(() => { });

        // Channel Check
        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
        if (requiredChannels.length > 0) {
            const missing = await checkChannelMembership(bot, userId, requiredChannels);
            if (missing.length > 0) {
                const startBotUrl = `https://t.me/${botUsername}?start=verify_${pollId}`;
                try {
                    await bot.answerCallbackQuery(id, { url: startBotUrl });
                } catch (e) {
                    await bot.answerCallbackQuery(id, { text: '⚠️ Kanallarga a\'zo bo\'ling!', show_alert: true }).catch(() => { });
                }
                return;
            }
        }

        // Time Check and Status Handling
        const now = new Date();
        const startTime = poll.start_time ? new Date(poll.start_time) : null;
        const endTime = poll.end_time ? new Date(poll.end_time) : null;

        const fmtDate = (d) => d ? d.toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

        // Case: Not Found (Handled above, but if logic flows here unexpectedly)
        if (!poll) {
            return bot.answerCallbackQuery(id, {
                text: '🚫 Kechirasiz, ushbu so\'rovnoma topilmadi yoki o\'chirilgan.\nAdmin bilan bog\'laning.',
                show_alert: true
            }).catch(() => { });
        }

        // Case: Not Started
        if (startTime && now < startTime) {
            return bot.answerCallbackQuery(id, {
                text: `⚠️ So'rovnoma hali boshlanmagan.\n\n🕒 Boshlanish vaqti: ${fmtDate(startTime)}`,
                show_alert: true
            }).catch(() => { });
        }

        // Case: Closed
        if (endTime && now > endTime) {
            const finalStats = getCompactPollResults(pollId);
            return bot.answerCallbackQuery(id, {
                text: `🔒 So'rovnoma yakunlangan.\n\n🏁 Tugash vaqti: ${fmtDate(endTime)}\n\n📊 Natijalar:\n${finalStats}`,
                show_alert: true
            }).catch(() => { });
        }

        // Vote
        const settings = JSON.parse(poll.settings_json || '{}');
        let msg = executeVoteTransaction(pollId, userId, optionId, settings);

        // --- Simplified Feedback (Alert) ---
        try {
            const optionRow = db.prepare('SELECT text FROM options WHERE id = ?').get(optionId);
            let safeOpt = optionRow ? optionRow.text : 'Variant';
            if (safeOpt.length > 50) safeOpt = safeOpt.substring(0, 47) + '...';

            let prefix = '✅ Ovoz qabul qilindi.';
            if (msg.includes('ozgartirildi')) prefix = '🔄 Ovoz o\'zgartirildi.';

            // Just show what they voted for, no stats
            let alertText = `${prefix}\n\nSiz tanladingiz: ${safeOpt}`;

            bot.answerCallbackQuery(id, { text: alertText, show_alert: true }).catch(() => { });

        } catch (alertErr) {
            console.error('Alert Logic Error:', alertErr);
            // Fallback
            bot.answerCallbackQuery(id, { text: `✅ ${msg}`, show_alert: false }).catch(() => { });
        }

        // Immediate Update

        const chatId = message ? message.chat.id : null;
        const messageId = message ? message.message_id : null;

        try {
            await updatePollMessage(bot, chatId, messageId, pollId, inline_message_id, botUsername);
        } catch (e) {
            console.error('Update Poll Error:', e.message);
        }

        // Background update for others (if any shared instances exist not covered by above)
        // Note: updateSharedPolls might be heavy, consider running it without await if it blocks too much, 
        // but for "instant" feel on the clicked message, the above await is key.
        updateSharedPolls(bot, pollId, botUsername).catch(err => console.error('Shared Update Error:', err.message));

        // Return to Channel Logic (if voted successfully and channels required)
        if (msg.includes('qabul qilindi') && requiredChannels.length > 0) {
            const firstChannel = requiredChannels[0];
            let channelUrl = firstChannel.url;
            if (!channelUrl && firstChannel.username) {
                channelUrl = `https://t.me/${firstChannel.username.replace('@', '')}`;
            }

            if (channelUrl) {
                // Send ephemeral hint or private message? 
                // Since this is callback, we can't open URL and alert.
                // We'll send a message to the user.
                // Removed 'Go back' message to reduce API load and prevent 429s.
                // The user remains in the chat or can manually navigate back.

            }
        }

    } catch (e) {
        // Don't log expected logic errors to console, just show to user
        const knownErrors = ['Ovozni ozgartira olmaysiz.', 'Faqat bitta variant tanlash mumkin.'];
        if (!knownErrors.includes(e.message)) {
            console.error('Vote Error:', e);
        }
        bot.answerCallbackQuery(id, { text: e.message, show_alert: true }).catch(() => { });
    }
}

module.exports = { handleVote };

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
        return [{
            text: `${opt.text} (${count})`,
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

// Re-implemented updatePollMessage here to avoid circular dependencies if possible.
// Or export it so voteHandler can use it.
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
        console.error('Error sending poll:', e.message);
        return false;
    }
}

async function updateSharedPolls(bot, pollId, botUsername) {
    // 1. Update Inline Shared Instances
    const sharedInstances = db.prepare('SELECT inline_message_id FROM shared_polls WHERE poll_id = ?').all(pollId);
    if (sharedInstances.length > 0) {
        const content = generateSharablePollContent(pollId, botUsername);
        if (content) {
            for (const instance of sharedInstances) {
                try {
                    await bot.editMessageCaption(content.caption, {
                        inline_message_id: instance.inline_message_id,
                        reply_markup: content.reply_markup,
                        parse_mode: 'HTML'
                    });
                } catch (e) {
                    if (e.message.includes('MESSAGE_ID_INVALID')) {
                        db.prepare('DELETE FROM shared_polls WHERE inline_message_id = ?').run(instance.inline_message_id);
                    }
                }
            }
        }
    }

    // 2. Update Direct Messages
    const directMessages = db.prepare('SELECT chat_id, message_id FROM poll_messages WHERE poll_id = ?').all(pollId);
    if (directMessages.length > 0) {
        for (const msg of directMessages) {
            updatePollMessage(bot, msg.chat_id, msg.message_id, pollId, null, botUsername)
                .catch(e => {
                    if (e.message.includes('chat not found') || e.message.includes('forbidden') || e.message.includes('message to edit not found')) {
                        db.prepare('DELETE FROM poll_messages WHERE chat_id = ? AND message_id = ?').run(msg.chat_id, msg.message_id);
                    }
                });
        }
    }
}

module.exports = {
    generatePollContent,
    generateSharablePollContent,
    getPollResults,
    sendPoll,
    updatePollMessage,
    updateSharedPolls
};

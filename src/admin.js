const db = require('./database');
const { sendPoll } = require('./voting');

// Load Super Admin IDs from Env
const SUPER_ADMINS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim(), 10))
    .filter(Boolean);

const isSuperAdmin = (userId) => {
    if (SUPER_ADMINS.includes(userId)) return true;
    try {
        const admin = db.prepare("SELECT role FROM admins WHERE user_id = ?").get(userId);
        return admin && admin.role === 'super_admin';
    } catch (e) { return false; }
};

const isAdmin = (userId) => {
    if (isSuperAdmin(userId)) return true;
    try {
        const admin = db.prepare('SELECT user_id FROM admins WHERE user_id = ?').get(userId);
        return !!admin;
    } catch (e) { return false; }
};

async function handleAdminCallback(bot, query) {
    const { from, data, message } = query;
    const parts = data.split(':');
    const action = parts[1];
    const pollId = parts[2];

    // SECURITY CHECK
    if (!isAdmin(from.id)) {
        return bot.answerCallbackQuery(query.id, { text: '⛔ Ruxsat yoq (Not Authorized)', show_alert: true });
    }

    try {
        if (action === 'start') {
            db.prepare("UPDATE polls SET start_time = datetime('now', '-1 minute'), end_time = NULL WHERE id = ?").run(pollId);
            bot.answerCallbackQuery(query.id, { text: '🟢 Sorovnoma ishga tushirildi!' });
            bot.sendMessage(message.chat.id, `✅ Sorovnoma #${pollId} ishga tushirildi.`);
        } else if (action === 'stop') {
            db.prepare('UPDATE polls SET end_time = CURRENT_TIMESTAMP, notified = 1 WHERE id = ?').run(pollId);
            bot.answerCallbackQuery(query.id, { text: '🛑 Sorovnoma toxtatildi!' });
            bot.sendMessage(message.chat.id, `🛑 Sorovnoma #${pollId} toxtatildi. Natijalar:`);
            sendPoll(bot, message.chat.id, pollId);
        } else if (action === 'results') {
            bot.answerCallbackQuery(query.id);
            sendPoll(bot, message.chat.id, pollId);
        } else if (action === 'delete') {
            // Step 1: Request Confirmation
            const buttons = [
                [
                    { text: '✅ HA, Ochirilsin', callback_data: `admin:confirm_delete:${pollId}` },
                    { text: '❌ Bekor qilish', callback_data: `admin:cancel_delete:${pollId}` }
                ]
            ];

            try {
                bot.editMessageText(`⚠️ **DIQQAT!**\n\nSiz rostdan ham Sorovnoma #${pollId} ni ochirmoqchimisiz?\n\n❗️ Bu amalni ortga qaytarib bolmaydi. Barcha ovozlar ochib ketadi.`, {
                    chat_id: message.chat.id,
                    message_id: message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buttons }
                });
            } catch (e) { }
            bot.answerCallbackQuery(query.id);

        } else if (action === 'confirm_delete') {
            // Step 2: Execute Delete (Cascade enabled in DB now)
            db.prepare('DELETE FROM polls WHERE id = ?').run(pollId);

            bot.answerCallbackQuery(query.id, { text: '🗑️ Sorovnoma ochirildi!' });
            try {
                bot.deleteMessage(message.chat.id, message.message_id);
                bot.sendMessage(message.chat.id, `🗑️ Sorovnoma #${pollId} muvaffaqiyatli ochirildi.`);
            } catch (e) { }

        } else if (action === 'cancel_delete') {
            // Step 3: Cancel (Restore Management View)
            const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
            if (!poll) {
                bot.answerCallbackQuery(query.id, { text: 'Sorovnoma topilmadi.', show_alert: true });
                return bot.deleteMessage(message.chat.id, message.message_id);
            }

            const status = (poll.end_time && new Date() > new Date(poll.end_time)) ? '🔒 Yopiq' : '🟢 Ochiq';
            const text = `⚙️ **Sorovnoma Boshqaruv**\n\n🆔 ID: ${poll.id}\n📝 ${poll.description}\n📅 Yaratilgan: ${poll.created_at}\n📊 Status: ${status}`;

            const buttons = [
                [
                    { text: '🟢 Boshlash', callback_data: `admin:start:${pollId}` },
                    { text: '🛑 Toxtatish', callback_data: `admin:stop:${pollId}` }
                ],
                [
                    { text: '📊 Natijalar', callback_data: `admin:results:${pollId}` },
                    { text: '♻️ Ulashish', switch_inline_query: `poll_${pollId}` }
                ],
                [
                    { text: '🗑️ Ochirish (Delete)', callback_data: `admin:delete:${pollId}` }
                ]
            ];

            bot.editMessageText(text, {
                chat_id: message.chat.id,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
            bot.answerCallbackQuery(query.id, { text: 'Bekor qilindi' });
        }
    } catch (e) {
        console.error('Admin Action Error:', e);
        bot.answerCallbackQuery(query.id, { text: '❌ Xatolik yuz berdi.' });
    }
}

module.exports = { isAdmin, isSuperAdmin, handleAdminCallback, SUPER_ADMINS };

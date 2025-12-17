const db = require('./database');
const { updatePollMessage, sendPoll } = require('./voting');

// State Store
const userState = new Map();

const STEPS = {
    MEDIA: 'WAITING_MEDIA',
    DESCRIPTION: 'WAITING_DESCRIPTION',
    OPTIONS: 'WAITING_OPTIONS',
    SETTINGS: 'WAITING_SETTINGS',
    CHANNELS: 'WAITING_CHANNELS'
};

function startWizard(bot, chatId, userId) {
    userState.set(userId, {
        step: STEPS.MEDIA,
        chatId: chatId,
        poll: {
            options: [],
            settings: { multiple_choice: false, allow_edit: true },
            required_channels: []
        }
    });
    bot.sendMessage(chatId, '🗳️ **Yangi sorovnoma yaratish**\\n\\n1-qadam: Rasm yoki video yuboring, yoki /skip yozing.');
}

async function handleWizardStep(bot, msg) {
    const userId = msg.from.id;
    const state = userState.get(userId);

    if (!state) return;

    // Reset flow check
    if (msg.text === '/cancel') {
        userState.delete(userId);
        return bot.sendMessage(state.chatId, '❌ Sorovnoma yaratish bekor qilindi.');
    }

    switch (state.step) {
        case STEPS.MEDIA:
            if (msg.photo) {
                // Get highest resolution photo
                state.poll.media_id = msg.photo[msg.photo.length - 1].file_id;
                state.poll.media_type = 'photo';
            } else if (msg.video) {
                state.poll.media_id = msg.video.file_id;
                state.poll.media_type = 'video';
            } else if (msg.text === '/skip') {
                state.poll.media_type = 'none';
            } else {
                return bot.sendMessage(state.chatId, '⚠️ Iltimos, rasm, video yuboring yoki /skip yozing.');
            }

            state.step = STEPS.DESCRIPTION;
            bot.sendMessage(state.chatId, '2-qadam: Sorovnoma matnini yuboring.');
            break;

        case STEPS.DESCRIPTION:
            if (!msg.text) return bot.sendMessage(state.chatId, '⚠️ Iltimos, matn yuboring.');
            state.poll.description = msg.text;
            state.step = STEPS.OPTIONS;
            bot.sendMessage(state.chatId, '3-qadam: Javob variantlarini yuboring (har birini alohida).', {
                reply_markup: {
                    keyboard: [['✅ Tugatish']],
                    resize_keyboard: true
                }
            });
            break;

        case STEPS.OPTIONS:
            if (!msg.text) return bot.sendMessage(state.chatId, '⚠️ Iltimos, javob variantini yuboring.');

            const text = msg.text.trim();
            if (text.toLowerCase() === '/done' || text === '✅ Tugatish' || text.toLowerCase() === 'done') {
                if (state.poll.options.length < 2) {
                    return bot.sendMessage(state.chatId, '⚠️ Kamida 2 ta variant kerak! Davom eting.');
                }
                state.step = STEPS.SETTINGS;
                // Remove keyboard
                bot.sendMessage(state.chatId, 'Variantlar saqlandi. Endi sozlamalarni tanlang:', { reply_markup: { remove_keyboard: true } });
                sendSettingsMenu(bot, state.chatId, state.poll.settings);
            } else {
                state.poll.options.push(text);
                bot.sendMessage(state.chatId, `✅ Qoshildi: "${text}"`);
            }
            break;

        case STEPS.CHANNELS:
            // This handled via text input for channels
            if (msg.text === '/done' || msg.text === '✅ Tugatish') {
                await finalizePoll(bot, userId);
            } else {
                // Simple validation
                const channels = msg.text.split(' ').map(c => c.trim()).filter(c => c.startsWith('@'));
                if (channels.length === 0) {
                    return bot.sendMessage(state.chatId, '⚠️ Notogri format. Kanallarni shunday yuboring: @kanal1 @kanal2');
                }
                state.poll.required_channels.push(...channels);
                bot.sendMessage(state.chatId, `✅ Qoshildi: ${channels.join(', ')}\n⚠️ Bot ushbu kanallarda ADMIN bo'lishi shart!\nTugatish uchun tugmani bosing.`);
            }
            break;
    }
}

// Settings are better handled via Inline Keyboard to toggle
function sendSettingsMenu(bot, chatId, settings) {
    const keyboard = [
        [{ text: `Kop tanlov: ${settings.multiple_choice ? '✅' : '❌'}`, callback_data: 'wiz_toggle:multiple_choice' }],
        [{ text: `Ovozni ozgartirish: ${settings.allow_edit ? '✅' : '❌'}`, callback_data: 'wiz_toggle:allow_edit' }],
        [{ text: '➡️ Keyingi qadam', callback_data: 'wiz_next' }]
    ];

    bot.sendMessage(chatId, '4-qadam: Sozlamalar', {
        reply_markup: { inline_keyboard: keyboard }
    });
}

// We need to attach this listener in index.js or here. 
// Ideally exports a handler.
function handleWizardCallback(bot, query) {
    const userId = query.from.id;
    const state = userState.get(userId);

    const data = query.data;

    // Handle settings toggles
    if (state && state.step === STEPS.SETTINGS) {
        if (data === 'wiz_next') {
            state.step = STEPS.CHANNELS;
            bot.editMessageText('5-qadam: Majburiy kanallar', {
                chat_id: state.chatId,
                message_id: query.message.message_id
            });
            bot.sendMessage(state.chatId, 'Ovoz berish uchun azo bolish kerak bolgan kanallarni yuboring (@kanal1 @kanal2).\n\nYoki tugmani bosing:', {
                reply_markup: {
                    keyboard: [['✅ Tugatish']],
                    resize_keyboard: true
                }
            });
        } else if (data.startsWith('wiz_toggle:')) {
            const key = data.split(':')[1];
            state.poll.settings[key] = !state.poll.settings[key];

            const keyboard = [
                [{ text: `Kop tanlov: ${state.poll.settings.multiple_choice ? '✅' : '❌'}`, callback_data: 'wiz_toggle:multiple_choice' }],
                [{ text: `Ovozni ozgartirish: ${state.poll.settings.allow_edit ? '✅' : '❌'}`, callback_data: 'wiz_toggle:allow_edit' }],
                [{ text: '➡️ Keyingi qadam', callback_data: 'wiz_next' }]
            ];

            bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, {
                chat_id: state.chatId,
                message_id: query.message.message_id
            });
        }
        return;
    }
}

async function finalizePoll(bot, userId) {
    const state = userState.get(userId);
    if (!state) return;

    const { poll, chatId } = state;

    // Save to DB
    try {
        const stmt = db.prepare('INSERT INTO polls (media_id, media_type, description, settings_json, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)');
        // No time features - set to null
        const result = stmt.run(poll.media_id, poll.media_type, poll.description, JSON.stringify(poll.settings), null, null);
        const pollId = result.lastInsertRowid;

        const optStmt = db.prepare('INSERT INTO options (poll_id, text) VALUES (?, ?)');
        for (const opt of poll.options) {
            optStmt.run(pollId, opt);
        }

        const chanStmt = db.prepare('INSERT INTO required_channels (poll_id, channel_username) VALUES (?, ?)');
        for (const chan of poll.required_channels) {
            chanStmt.run(pollId, chan);
        }

        userState.delete(userId);

        // Send the poll
        await sendPoll(bot, chatId, pollId);

        // Get Bot Username for deep link
        const me = await bot.getMe();
        const botUsername = me.username;

        bot.sendMessage(chatId, `🎉 Sorovnoma yaratildi! ID: ${pollId}\n\nUlashish uchun:\n1. Guruhga botni qoshing\n2. Guruhda \`/poll ${pollId}\` deb yozing\n\nYoki bu linkni yuboring:\nhttps://t.me/${botUsername}?start=poll_${pollId}`);

        // Restore Main Menu
        bot.sendMessage(chatId, 'Sorovnoma yuqorida joylashtirildi.', {
            reply_markup: {
                keyboard: [
                    ['📝 Sorovnoma yaratish'],
                    ['📋 Sorovnoma royxatlari', '⏳ Davom etayotgan']
                ],
                resize_keyboard: true
            }
        });

    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Malumotlar bazasiga saqlashda xatolik.');
        userState.delete(userId);
    }
}

module.exports = { startWizard, handleWizardStep, handleWizardCallback };

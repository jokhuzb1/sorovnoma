require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const db = require('./database');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { startWizard, handleWizardStep, handleWizardCallback } = require('./wizard');
const { handleVote, sendPoll, checkChannelMembership, generatePollContent } = require('./voting');

const { isAdmin, isSuperAdmin, handleAdminCallback, SUPER_ADMINS } = require('./admin');
const { saveDraft, getDraft } = require('./drafts');

// Validate Environment
if (!process.env.BOT_TOKEN) {
    console.error('CRITICAL: BOT_TOKEN is missing in .env');
    process.exit(1);
}

// ... (Express Setup) ... 

console.log(`Bot started! Super Admin IDs: ${SUPER_ADMINS.join(', ')}`);

// ... (API Routes - isAdmin is now imported) ... 

// ... (Bot Commands - isAdmin is now imported) ...


// --- EXPRESS SERVER SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
    console.log(`[SERVER] ${req.method} ${req.url}`);
    next();
});

// Multer Config
const uploadDir = path.join(__dirname, '../public/uploads/');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Initialize Bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --- API ROUTES ---

// Draft Media Endpoint
app.get('/api/draft-media', (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.json({ media: null });

    // Parse int safe
    const uid = parseInt(userId);
    const draft = getDraft(uid);
    res.json({ media: draft });
});

app.post('/api/create-poll', upload.single('media'), async (req, res) => {
    try {
        const { question, options, multiple_choice, allow_edit, start_time, end_time, channels, user_id } = req.body;
        console.log('[API] Debug Body:', JSON.stringify(req.body, null, 2));

        // --- 1. STRICT INPUT VALIDATION ---

        // User ID (Required)
        if (!user_id || !isAdmin(parseInt(user_id))) {
            return res.status(403).json({ success: false, message: '⛔ Ruxsat berilmagan (Not Authorized)' });
        }

        // Question (Required, String, Not Empty)
        const cleanQuestion = String(question || '').trim();
        if (!cleanQuestion) {
            return res.status(400).json({ success: false, message: '❌ Savol matni bo\'sh bo\'lishi mumkin emas!' });
        }


        // Options (Required, Array, Min 2, Non-empty)
        let optionsList = [];
        if (Array.isArray(options)) {
            optionsList = options;
        } else if (typeof options === 'string') {
            optionsList = [options];
        }

        // sanitize options
        optionsList = optionsList
            .map(opt => String(opt || '').trim())
            .filter(opt => opt.length > 0);

        if (optionsList.length < 2) {
            return res.status(400).json({ success: false, message: '❌ Kamida 2 ta variant kiritilishi shart!' });
        }

        // Channels Validation (Strict)
        let validChannels = [];
        if (channels) {
            const raw = String(channels).split(',').map(c => c.trim().replace(/^@/, '')).filter(c => c.length > 0);

            for (const ch of raw) {
                try {
                    const chat = await bot.getChat('@' + ch);
                    if (chat.type !== 'channel' && chat.type !== 'supergroup') {
                        return res.status(400).json({ success: false, message: `❌ @${ch} kanal yoki guruh emas!` });
                    }
                    // verify admin rights
                    try {
                        const me = await bot.getChatMember(chat.id, (await bot.getMe()).id);
                        if (!['administrator', 'creator'].includes(me.status)) {
                            return res.status(400).json({ success: false, message: `❌ Bot @${ch} kanalida admin emas!` });
                        }
                    } catch (adminError) {
                        return res.status(400).json({ success: false, message: `❌ Bot @${ch} kanalida admin emas! (Tekshirishda xatolik)` });
                    }

                    validChannels.push('@' + ch);
                } catch (e) {
                    console.warn(`[API] Invalid Channel ${ch}: ${e.message}`);
                    return res.status(400).json({ success: false, message: `❌ Bot @${ch} kanalini topa olmadi yoki a'zo emas!` });
                }
            }
        }


        // --- 2. MEDIA HANDLING (STRICT) ---

        let mediaId = null;
        let mediaType = 'none';
        const file = req.file;

        if (file) {
            console.log(`[API] Processing file: ${file.originalname} (${file.mimetype})`);
            const filePath = file.path;
            try {
                let sentMsg;
                // Validate mime type explicitly before sending to Telegram
                if (file.mimetype.startsWith('image/')) {
                    sentMsg = await bot.sendPhoto(user_id, fs.createReadStream(filePath), { caption: 'Media Upload Verification' });
                    // Telegram photo structure: array of sizes. We take the last (largest).
                    if (sentMsg.photo && sentMsg.photo.length > 0) {
                        mediaId = sentMsg.photo[sentMsg.photo.length - 1].file_id;
                        mediaType = 'photo';
                    }
                } else if (file.mimetype.startsWith('video/')) {
                    sentMsg = await bot.sendVideo(user_id, fs.createReadStream(filePath), { caption: 'Media Upload Verification' });
                    if (sentMsg.video) {
                        mediaId = sentMsg.video.file_id;
                        mediaType = 'video';
                    }
                } else {
                    console.warn('[API] Unsupported file type:', file.mimetype);
                }
            } catch (e) {
                console.error('[API] Media upload failed:', e.message);
            } finally {
                // Always clean up temp file
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        } else if (req.body.media_id && req.body.media_type) {
            // Direct Media ID from Draft/Chat
            mediaId = req.body.media_id;
            mediaType = req.body.media_type;
            console.log(`[API] Using existing media_id: ${mediaId} (${mediaType})`);
        }

        // Double check strict types for DB
        if (typeof mediaId !== 'string') mediaId = null;
        if (typeof mediaType !== 'string') mediaType = 'none';

        // --- 3. NORMALIZATION & DB INSERT ---

        const settings = JSON.stringify({
            multiple_choice: multiple_choice === 'on' || multiple_choice === 'true',
            allow_edit: allow_edit === 'on' || allow_edit === 'true'
        });

        // Date Cleaning & Logic
        let startTimeVal = null; // Stored as INTEGER (Unix Timestamp ms) or null
        let endTimeVal = null;
        let published = 0;

        const now = Date.now();

        if (start_time && start_time !== 'null' && start_time.trim() !== '') {
            const parsed = Date.parse(start_time);
            if (!isNaN(parsed)) {
                startTimeVal = parsed;
                // If start time is in the future (> now + 5 seconds buffer), it's scheduled.
                // Otherwise it's immediate.
                if (startTimeVal > now + 1000) {
                    published = 0;
                } else {
                    published = 1;
                }
            }
        } else {
            // No start time = Immediate
            published = 1;
        }

        if (end_time && end_time !== 'null' && end_time.trim() !== '') {
            const parsed = Date.parse(end_time);
            if (!isNaN(parsed)) {
                endTimeVal = parsed;
            }
        }

        const stmt = db.prepare(`
            INSERT INTO polls (
                media_id, media_type, description, settings_json, start_time, end_time, creator_id, published
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Execute with explicit params to avoid "undefined"
        const info = stmt.run(
            mediaId,        // can be null or string
            mediaType,      // string
            cleanQuestion,  // string
            settings,       // string
            startTimeVal,   // INTEGER or null
            endTimeVal,     // INTEGER or null
            user_id,        // INTEGER (creator_id)
            published       // INTEGER (0 or 1)
        );

        const pollId = info.lastInsertRowid;
        console.log(`[API] Poll created with ID: ${pollId}`);

        // Save Options
        const insertOption = db.prepare('INSERT INTO options (poll_id, text) VALUES (?, ?)');
        optionsList.forEach(opt => {
            insertOption.run(pollId, opt);
        });

        // Save Channels (Phase 3 Prep)
        if (channels) {
            const channelList = String(channels)
                .split(',')
                .map(c => c.trim().replace(/^@/, '')) // remove starting @ if present
                .filter(c => c.length > 0);

            if (channelList.length > 0) {
                const insertChannel = db.prepare('INSERT INTO required_channels (poll_id, channel_username, channel_id, channel_title) VALUES (?, ?, ?, ?)');

                for (const ch of channelList) {
                    try {
                        const chat = await bot.getChat('@' + ch);
                        const channelId = chat.id;
                        const channelTitle = chat.title || ('@' + ch);

                        console.log(`[API] Resolved Channel @${ch} -> ID: ${channelId}`);
                        insertChannel.run(pollId, '@' + ch, channelId, channelTitle);
                    } catch (e) {
                        console.warn(`[API] Failed to resolve channel @${ch} during save (might have been kicked): ${e.message}`);
                        // Fallback: Store without ID? No, strictly require ID now? 
                        // Instructions say "Reject channel if... Channel ID cannot be resolved"
                        // But we already validated in step 1. Ideally we should have resolved map there.
                        // For now, if getChat fails here (rare race condition), we skip saving it.
                    }
                }
            }
        }

        // Send to Creator
        await sendPoll(bot, user_id, pollId);

        res.json({ success: true, pollId });

    } catch (error) {
        console.error('[API] Critical Error:', error);
        res.status(500).json({ success: false, message: 'Server Xatoligi: ' + error.message });
    }
});
// Start Server
app.listen(PORT, () => {
    console.log(`Web Server running on port ${PORT}`);
});

// STARTUP: Get Bot Username
let BOT_USERNAME = null;
bot.getMe().then(me => {
    BOT_USERNAME = me.username;
    console.log(`Bot username: ${BOT_USERNAME}`);
});

// --- DEEP LINK HANDLER (Authentication Flow) ---
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const payload = match[1]; // content after /start

    if (!payload || !payload.startsWith('verify_')) {
        // Normal Start
        return bot.sendMessage(chatId, '👋 Salom! Men Sorovnoma Botman.\n\nSorovnoma yaratish uchun /newpoll buyrug\'ini yuboring (Adminlar uchun).');
    }

    // Verify Payload
    const pollId = parseInt(payload.replace('verify_', ''), 10);
    if (isNaN(pollId)) return bot.sendMessage(chatId, '❌ Xato havolasi.');

    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
    if (!poll) return bot.sendMessage(chatId, '❌ Sorovnoma topilmadi.');

    // Check Channels
    const requiredChannels = db.prepare('SELECT channel_username FROM required_channels WHERE poll_id = ?').all(pollId).map(r => r.channel_username);

    // Perform detailed check
    const { checkChannelMembership } = require('./voting');
    const missing = await checkChannelMembership(bot, userId, requiredChannels);

    if (missing.length === 0) {
        return bot.sendMessage(chatId, '✅ **Siz barcha kanallarga a\'zo bo\'lgansiz!**\n\nEndi ovoz berishingiz mumkin.', { parse_mode: 'Markdown' });
    }

    const buttons = missing.map(ch => {
        const username = ch.replace('@', '');
        return [{ text: `➕ ${ch} ga a'zo bo'lish`, url: `https://t.me/${username}` }];
    });

    buttons.push([{ text: '✅ Tekshirish', callback_data: `check_sub:${pollId}` }]);

    bot.sendMessage(chatId, `🛑 **Ovoz berish uchun quyidagi kanallarga a'zo bo'ling:**`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
});

// Handle 'check_sub' callback inside bot
bot.on('callback_query', async (query) => {
    if (query.data.startsWith('check_sub:')) {
        const pollId = parseInt(query.data.split(':')[1]);
        const userId = query.from.id;

        const requiredChannels = db.prepare('SELECT channel_username FROM required_channels WHERE poll_id = ?').all(pollId).map(r => r.channel_username);
        const { checkChannelMembership } = require('./voting'); // Lazy import to avoid cycle if any
        const missing = await checkChannelMembership(bot, userId, requiredChannels);

        if (missing.length === 0) {
            await bot.answerCallbackQuery(query.id, { text: '✅ Rahmat! Endi ovoz berishingiz mumkin.', show_alert: true });
            await bot.sendMessage(query.message.chat.id, '✅ Muvaffaqiyatli tasdiqlandi. Ovoz berish xabariga qaytib, ovoz bering!');
        } else {
            await bot.answerCallbackQuery(query.id, { text: `❌ Hali ${missing.length} ta kanalga a'zo emassiz.`, show_alert: true });
        }
    }
});

// (Middleware removed - imported from admin.js)

// --- Admin Management Commands ---

bot.onText(/\/addadmin(?: (\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let newAdminId = match[1] ? parseInt(match[1]) : null;

    if (!newAdminId && msg.reply_to_message) {
        newAdminId = msg.reply_to_message.from.id;
    }

    if (!newAdminId) {
        return bot.sendMessage(chatId, '⚠️ Iltimos, ID kiriting yoki foydalanuvchi xabariga javob (reply) qiling.');
    }

    // Legacy command check (optional, since UI is preferred)
    if (!isSuperAdmin(userId)) return bot.sendMessage(chatId, '⛔ Faqat Super Adminlar admin qo\'shishi mumkin.');

    try {
        db.prepare('INSERT OR IGNORE INTO admins (user_id, added_by) VALUES (?, ?)').run(newAdminId, userId);
        bot.sendMessage(chatId, `✅ Foydalanuvchi ${newAdminId} admin sifatida qo'shildi.`);
    } catch (e) {
        bot.sendMessage(chatId, '❌ Xatolik yuz berdi.');
    }
});

bot.onText(/\/removeadmin(?: (\d+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let targetId = match[1] ? parseInt(match[1]) : null;

    if (!targetId && msg.reply_to_message) {
        targetId = msg.reply_to_message.from.id;
    }

    if (!targetId) {
        return bot.sendMessage(chatId, '⚠️ Iltimos, ID kiriting yoki foydalanuvchi xabariga javob (reply) qiling.');
    }

    if (!SUPER_ADMINS.includes(userId)) return bot.sendMessage(chatId, '⛔ Faqat Super Adminlar adminni o\'chirishi mumkin.');

    db.prepare('DELETE FROM admins WHERE user_id = ?').run(targetId);
    bot.sendMessage(chatId, `🗑️ Foydalanuvchi ${targetId} adminlar safidan chiqarildi.`);
});

bot.onText(/\/listadmins/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const admins = db.prepare('SELECT user_id FROM admins').all();
    const list = admins.map(a => `• \`${a.user_id}\``).join('\n');
    bot.sendMessage(msg.chat.id, `👮 **Adminlar Ro'yxati**:\n${list || 'Hozircha adminlar yo\'q (Super Admindan tashqari)'}`, { parse_mode: 'Markdown' });
});

// --- Main Menu & Command Handlers ---

const MENUS = {
    MAIN: {
        reply_markup: {
            keyboard: [
                ['📝 Yangi Sorovnoma'],
                ['📋 Boshqarish (Barchasi)', '⏳ Boshqarish (Aktiv)']
            ],
            resize_keyboard: true
        }
    }
};

// Handle "Yangi Sorovnoma"
bot.on('message', (msg) => {
    if (msg.text === '📝 Yangi Sorovnoma') {
        if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ You are not authorized.');

        const webAppUrl = 'https://sorovnoma.freeddns.org';
        bot.sendMessage(msg.chat.id, '📝 <b>Yangi Sorovnoma Yaratish</b>\n\nQuyidagi tugmani bosib, sorovnoma yaratish oynasini oching:', {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: "📲 Sorovnoma Yaratish (Mini App)", web_app: { url: webAppUrl } }
                ]]
            }
        });
    }
});

// Handle "Boshqarish (Barchasi)"
bot.on('message', (msg) => {
    if (msg.text === '📋 Boshqarish (Barchasi)') {
        if (!isAdmin(msg.from.id)) return;
        listPolls(msg.chat.id);
    }
});

// Handle "Boshqarish (Aktiv)"
bot.on('message', (msg) => {
    if (msg.text === '⏳ Boshqarish (Aktiv)') {
        if (!isAdmin(msg.from.id)) return;
        listPolls(msg.chat.id, true);
    }
});

// Handle "👥 Adminlar" (Super Admin Only)
bot.on('message', (msg) => {
    if (msg.text === '👥 Adminlar') {
        if (!isSuperAdmin(msg.from.id)) return;

        const admins = db.prepare('SELECT * FROM admins').all();
        const buttons = admins.map(a => {
            const roleBadge = a.role === 'super_admin' ? '🌟' : '👤';
            return [{ text: `${roleBadge} ${a.user_id}`, callback_data: `admin_info:${a.user_id}` }, { text: '🗑️ O\'chirish', callback_data: `super:remove:${a.user_id}` }];
        });

        buttons.push([{ text: '➕ Admin Qo\'shish', callback_data: 'super:add' }]);
        buttons.push([{ text: '➕ SUPER Admin Qo\'shish', callback_data: 'super:add_super' }]);

        bot.sendMessage(msg.chat.id, '👮 **Adminlar Boshqaruvi**:\n\n🌟 = Super Admin\n👤 = Oddiy Admin', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }
});

// Handle Reply for Adding Admin
bot.on('message', (msg) => {
    if (msg.reply_to_message && msg.reply_to_message.text.startsWith('Iltimos, yangi')) {
        if (!isSuperAdmin(msg.from.id)) return;

        const isSuper = msg.reply_to_message.text.includes('SUPER');
        const role = isSuper ? 'super_admin' : 'admin';
        const newAdminId = parseInt(msg.text);

        if (isNaN(newAdminId)) return bot.sendMessage(msg.chat.id, '❌ Iltimos, to\'g\'ri raqamli ID kiriting.');

        try {
            // Check column existence implicitly by run. If migration failed this throws, but we added it.
            db.prepare('INSERT OR IGNORE INTO admins (user_id, added_by, role) VALUES (?, ?, ?)').run(newAdminId, msg.from.id, role);
            bot.sendMessage(msg.chat.id, `✅ ${isSuper ? 'SUPER ' : ''}Admin ${newAdminId} muvaffaqiyatli qo'shildi!`);
        } catch (e) {
            console.error(e);
            bot.sendMessage(msg.chat.id, '❌ Xatolik yuz berdi. (Bazani tekshiring)');
        }
    }
});

function listPolls(chatId, onlyOngoing = false) {
    let query = 'SELECT * FROM polls ORDER BY created_at DESC LIMIT 20';
    let params = [];

    if (onlyOngoing) {
        query = 'SELECT * FROM polls WHERE (start_time IS NULL OR start_time <= ?) AND (end_time IS NULL OR end_time >= ?) ORDER BY created_at DESC LIMIT 20';
        const now = new Date().toISOString();
        params = [now, now];
    }

    const polls = db.prepare(query).all(...params);

    if (polls.length === 0) {
        return bot.sendMessage(chatId, '📭 So\'rovnomalar topilmadi.');
    }

    let text = onlyOngoing ? '⏳ <b>Davom etayotgan so\'rovnomalar</b>:\n' : '📋 <b>Barcha so\'rovnomalar</b>:\n';

    polls.forEach(p => {
        const date = new Date(p.created_at).toLocaleDateString();
        const status = (p.end_time && new Date() > new Date(p.end_time)) ? '🔒 Yopiq' : '🟢 Ochiq';
        // HTML escape simple approach or just assume description is clean text. To be safe, just standard text.
        text += `\n🆔 /manage_${p.id} | 📅 ${date}\n📝 ${p.description.substring(0, 30)}...\nStatus: ${status}\n────────────────`;
    });

    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

// Handle /newpoll
bot.onText(/\/newpoll/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check if user is in SUPER_ADMINS
    if (!SUPER_ADMINS.includes(userId)) {
        return bot.sendMessage(chatId, '❌ Sizda bu buyruqni ishlatish huquqi yoq.');
    }

    const webAppUrl = 'https://sorovnoma.freeddns.org';

    bot.sendMessage(chatId, '📝 <b>Yangi Sorovnoma Yaratish</b>\n\nAvval media fayl yuklaysizmi yoki birdaniga boshlaysizmi?', {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "� Rasm", callback_data: "newpoll:photo" },
                    { text: "🎥 Video", callback_data: "newpoll:video" }
                ],
                [
                    { text: "⏭️ O'tkazib yuborish (Skip)", callback_data: "newpoll:skip" }
                ]
            ]
        }
    });
});

// Command: /poll <id> (To fetch/share a poll)
bot.onText(/\/poll (\d+)/, async (msg, match) => {
    const pollId = match[1];
    await sendPoll(bot, msg.chat.id, pollId);
});



// ...

// (Duplicate removed)

// ...

// Handle Callback Queries (Voting & Wizard)
bot.on('callback_query', async (query) => {
    console.log(`[Callback] From: ${query.from.id}, Data: ${query.data}`);

    // Verify check callback
    if (query.data.startsWith('check_verify:')) {
        const pollId = query.data.split(':')[1];
        const userId = query.from.id;

        const requiredChannels = db.prepare('SELECT * FROM required_channels WHERE poll_id = ?').all(pollId);
        const { checkChannelMembership } = require('./voting');
        const missing = await checkChannelMembership(bot, userId, requiredChannels);

        if (missing.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '✅ Tasdiqlandi! Ovoz berishingiz mumkin.', show_alert: true });

            // Delete the "Join Channels" warning message
            try {
                bot.deleteMessage(query.message.chat.id, query.message.message_id);
            } catch (e) { }

            // Optionally resend poll? No, user has the poll above.
            // Just let them click vote again.

        } else {
            const missingTitles = missing.map(m => m.title).join(', ');
            bot.answerCallbackQuery(query.id, { text: `❌ Siz hali ham quyidagi kanallarga a'zo bo'lmadingiz:\n\n${missingTitles}`, show_alert: true });
        }
        return;
    }

    if (query.data.startsWith('wiz_')) {
        handleWizardCallback(bot, query);
    } else {
        handleVote(bot, query, BOT_USERNAME);
    }
});

// Handle /start with deep link
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const param = match[1];

    if (param) {
        if (param.startsWith('poll_')) {
            const pollId = param.split('_')[1];
            return await sendPoll(bot, chatId, pollId);
        }
        if (param.startsWith('verify_')) {
            const pollId = param.split('_')[1];

            // Show channel list
            const requiredChannels = db.prepare('SELECT channel_username FROM required_channels WHERE poll_id = ?').all(pollId).map(r => r.channel_username);

            if (requiredChannels.length === 0) {
                return bot.sendMessage(chatId, '✅ Bu sorovnoma uchun majburiy kanallar yoq.');
            }

            const buttons = requiredChannels.map(ch => {
                const username = ch.replace('@', '');
                return [{ text: `➕ ${ch} ga azo bolish`, url: `https://t.me/${username}` }];
            });

            buttons.push([{ text: '✅ Tekshirish', callback_data: `check_verify:${pollId}` }]);

            await bot.sendMessage(chatId, '🛑 **Diqqat! Ovoz berish uchun quyidagi kanallarga azo boling:**', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
            return;
        }
    }

    // Dynamic Menu for Super Admins
    const keyboard = [
        ['📝 Yangi Sorovnoma'],
        ['📋 Boshqarish (Barchasi)', '⏳ Boshqarish (Aktiv)']
    ];

    if (SUPER_ADMINS.includes(userId)) {
        keyboard.push(['👥 Adminlar']);
    }

    bot.sendMessage(chatId, 'Assalomu Aleykum, Botga hush kelibsiz! Kerakli bo\'limni tanlang:', {
        reply_markup: {
            keyboard: keyboard,
            resize_keyboard: true
        }
    });
});

// Command: /closepoll <id>
bot.onText(/\/closepoll (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const pollId = match[1];

    // Set end_time to now
    const info = db.prepare('UPDATE polls SET end_time = CURRENT_TIMESTAMP WHERE id = ?').run(pollId);
    if (info.changes > 0) {
        bot.sendMessage(msg.chat.id, `🔒 Poll ${pollId} closed.`);
        // Ideally we should find the message ID and update it immediately, 
        // but we don't store message_id/chat_id of the posted poll in DB.
        // For now, next interaction will show it's closed.
    } else {
        bot.sendMessage(msg.chat.id, '❌ Poll not found.');
    }
});

// Handle Text Messages (for Wizard)
bot.on('message', (msg) => {
    console.log(`[Message] From: ${msg.from.id} (${msg.from.username}), Text: ${msg.text}`);
    // Ignore commands handled by onText
    if (msg.text && msg.text.startsWith('/')) return;

    // Also handle photo/video for wizard
    if (msg.text || msg.photo || msg.video) {
        handleWizardStep(bot, msg);
    }
});

// Handle Callback Queries (Voting & Wizard)
// Command: /startpoll <id> (Manually start a poll now)
bot.onText(/\/startpoll (\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const pollId = match[1];

    // Set start_time to now (nullify if you want it 'always open', but here we set to now means 'started')
    // Actually, setting start_time to now (or slightly past) effectively starts it if it was in future
    // Or if we want to remove start_time constraint:
    // db.prepare('UPDATE polls SET start_time = NULL WHERE id = ?').run(pollId);
    // But better to just set it to current timestamp

    const info = db.prepare("UPDATE polls SET start_time = datetime('now', '-1 minute') WHERE id = ?").run(pollId);

    if (info.changes > 0) {
        bot.sendMessage(msg.chat.id, `✅ Poll ${pollId} manually started!`);
        sendPoll(bot, msg.chat.id, pollId); // Show it immediately
    } else {
        bot.sendMessage(msg.chat.id, '❌ Poll not found.');
    }
});

// Handle Callback Queries (Voting, Wizard & Admin)
bot.on('callback_query', async (query) => {
    const { from, data, message } = query;

    if (data.startsWith('newpoll:')) {
        const type = data.split(':')[1];
        const webAppUrl = 'https://sorovnoma.freeddns.org';

        if (type === 'skip') {
            bot.sendMessage(message.chat.id, '📝 <b>Yangi Sorovnoma Yaratish</b>\n\nBoshlash uchun tugmani bosing:', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "📲 Sorovnoma Yaratish (Mini App)", web_app: { url: webAppUrl } }
                    ]]
                }
            });
            bot.answerCallbackQuery(query.id);
        } else if (type === 'photo') {
            bot.sendMessage(message.chat.id, '📸 Iltimos, <b>Rasm</b> yuboring:');
            bot.answerCallbackQuery(query.id);
        } else if (type === 'video') {
            bot.sendMessage(message.chat.id, '🎥 Iltimos, <b>Video</b> yuboring:');
            bot.answerCallbackQuery(query.id);
        }
    } else if (data.startsWith('wiz_')) {
        handleWizardCallback(bot, query);
    } else if (data.startsWith('admin:')) {
        const parts = data.split(':');
        const action = parts[1];
        const pollId = parts[2];

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

    } else if (data.startsWith('super:')) {
        // Super Admin Actions
        if (!SUPER_ADMINS.includes(from.id)) return bot.answerCallbackQuery(query.id, { text: '⛔ Not Authorized', show_alert: true });

        const parts = data.split(':');
        const action = parts[1];

        if (action === 'remove') {
            const targetId = parts[2];
            db.prepare('DELETE FROM admins WHERE user_id = ?').run(targetId);
            bot.answerCallbackQuery(query.id, { text: `🗑️ Admin ${targetId} o'chirildi.` });

            // Refresh the admin list message
            const admins = db.prepare('SELECT user_id FROM admins').all();
            const buttons = admins.map(a => {
                return [{ text: `👤 ${a.user_id}`, callback_data: `admin_info:${a.user_id}` }, { text: '🗑️ O\'chirish', callback_data: `super:remove:${a.user_id}` }];
            });
            buttons.push([{ text: '➕ Admin Qo\'shish', callback_data: 'super:add' }]);

            bot.editMessageReplyMarkup({ inline_keyboard: buttons }, { chat_id: message.chat.id, message_id: message.message_id });
        } else if (action === 'add') {
            bot.sendMessage(message.chat.id, 'Iltimos, yangi adminning Telegram ID raqamini yozib yuboring: (Oddiy Admin)', {
                reply_markup: { force_reply: true }
            });
            bot.answerCallbackQuery(query.id);
        } else if (action === 'add_super') {
            bot.sendMessage(message.chat.id, 'Iltimos, yangi SUPER Adminning Telegram ID raqamini yozib yuboring:', {
                reply_markup: { force_reply: true }
            });
            bot.answerCallbackQuery(query.id);
        }

    } else if (data.startsWith('check_verify:')) {
        const pollId = data.split(':')[1];
        const userId = from.id;
        const requiredChannels = db.prepare('SELECT channel_username FROM required_channels WHERE poll_id = ?').all(pollId).map(r => r.channel_username);
        const missing = await checkChannelMembership(bot, userId, requiredChannels);

        if (missing.length === 0) {
            bot.sendMessage(message.chat.id, '✅ Rahmat! Kanallarga azo boldingiz. Ovoz berishingiz mumkin:');
            await sendPoll(bot, message.chat.id, pollId);
            try { bot.deleteMessage(message.chat.id, message.message_id); } catch (e) { }
        } else {
            bot.answerCallbackQuery(query.id, { text: `❌ Siz hali ham ${missing.join(', ')} kanallariga azo bolmadingiz!`, show_alert: true });
        }
    } else {
        handleVote(bot, query, BOT_USERNAME);
    }
});

// Command: /manage_<id> (Admin Dashboard)
bot.onText(/\/manage_(\d+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const pollId = match[1];
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);

    if (!poll) return bot.sendMessage(msg.chat.id, '❌ Poll not found.');

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

    bot.sendMessage(msg.chat.id, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
});

// Inline Query Handler (For Sharing)
bot.on('inline_query', async (query) => {
    const { id, query: queryString } = query;
    const { generatePollContent } = require('./voting');

    let pollId = null;
    if (queryString.startsWith('poll_')) {
        pollId = queryString.split('_')[1];
    }

    if (!pollId) return bot.answerInlineQuery(id, []);

    const content = generatePollContent(pollId);
    if (!content) return bot.answerInlineQuery(id, [], { switch_pm_text: "Sorovnoma topilmadi", switch_pm_parameter: "nopoll" });

    const { caption, reply_markup, poll } = content;

    const result = {
        type: poll.media_type === 'none' ? 'article' : poll.media_type,
        id: `poll_${poll.id}`,
        title: 'Sorovnoma',
        description: poll.description,
        reply_markup: reply_markup,
        thumb_url: 'https://cdn-icons-png.flaticon.com/512/2633/2633649.png' // Generic thumbnail for text polls
    };

    if (poll.media_type === 'photo') {
        result.photo_file_id = poll.media_id;
        result.caption = caption;
    } else if (poll.media_type === 'video') {
        result.video_file_id = poll.media_id;
        result.caption = caption;
        result.title = 'Sorovnoma (Video)';
    } else {
        result.input_message_content = { message_text: caption };
    }

    try {
        await bot.answerInlineQuery(id, [result], { cache_time: 0 });
    } catch (e) {
        console.error('Inline Query Error:', e.message);
    }
});

// ------------------------------------------------------------------
// Background Task: Scheduler (Auto-Start & Auto-End)
// ------------------------------------------------------------------
function checkPollTimers() {
    try {
        const now = Date.now();

        // 1. Check for Polls to START (Published = 0, Start Time passed)
        const pendingPolls = db.prepare('SELECT * FROM polls WHERE published = 0 AND start_time IS NOT NULL AND start_time <= ?').all(now);

        pendingPolls.forEach(async (poll) => {
            console.log(`[Scheduler] Starting Poll #${poll.id}...`);

            // Mark as published
            db.prepare('UPDATE polls SET published = 1 WHERE id = ?').run(poll.id);

            // Notify Creator (if we have ID)
            if (poll.creator_id) {
                bot.sendMessage(poll.creator_id, `🟢 **Sorovnoma Boshlandi** (#${poll.id})\n\nSorovnoma avtomatik ravishda e'lon qilindi.`, { parse_mode: 'Markdown' });
                await sendPoll(bot, poll.creator_id, poll.id);
            } else {
                // Fallback: Notify Super Admins if creator unknown
                SUPER_ADMINS.forEach(adminId => {
                    bot.sendMessage(adminId, `🟢 **Sorovnoma Boshlandi** (#${poll.id}) (Creator Unknown)`);
                    sendPoll(bot, adminId, poll.id);
                });
            }
        });

        // 2. Check for Polls to END (Notified = 0, End Time passed)
        const expiredPolls = db.prepare('SELECT * FROM polls WHERE notified = 0 AND end_time IS NOT NULL AND end_time <= ?').all(now);

        expiredPolls.forEach(poll => {
            console.log(`[Scheduler] Ending Poll #${poll.id}...`);

            // Mark as notified (closed)
            db.prepare('UPDATE polls SET notified = 1 WHERE id = ?').run(poll.id);

            // Notify Creator
            if (poll.creator_id) {
                bot.sendMessage(poll.creator_id, `🔒 **Sorovnoma Yakunlandi** (#${poll.id})\n\nVaqt tugadi. Natijalar:`, { parse_mode: 'Markdown' });
                sendPoll(bot, poll.creator_id, poll.id);
            } else {
                SUPER_ADMINS.forEach(adminId => {
                    bot.sendMessage(adminId, `🔒 **Sorovnoma Yakunlandi** (#${poll.id})`);
                    sendPoll(bot, adminId, poll.id);
                });
            }
        });

    } catch (e) {
        console.error('[Scheduler] Error:', e.message);
    }
}

// Run Scheduler every 10 seconds
setInterval(checkPollTimers, 10000);


// Error Handling
// Global Error Handlers
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    // process.exit(1); // Optional: Restart via PM2/Docker usually better, but for now keep alive if possible or exit safe.
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('[System] Bot is ready and running.');

// --- MEDIA LISTENERS (For Drafts) ---
const webAppUrl = 'https://sorovnoma.freeddns.org';
const miniAppButton = {
    inline_keyboard: [[
        { text: "📲 Sorovnoma Yaratishni Boshlash", web_app: { url: webAppUrl } }
    ]]
};

bot.on('photo', (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const photo = msg.photo[msg.photo.length - 1]; // Largest
    saveDraft(msg.from.id, 'photo', photo.file_id);
    bot.sendMessage(msg.chat.id, '✅ Rasm qabul qilindi! Endi davom etishingiz mumkin:', { reply_markup: miniAppButton });
});

bot.on('video', (msg) => {
    if (!isAdmin(msg.from.id)) return;
    saveDraft(msg.from.id, 'video', msg.video.file_id);
    bot.sendMessage(msg.chat.id, '✅ Video qabul qilindi! Endi davom etishingiz mumkin:', { reply_markup: miniAppButton });
});

bot.on('document', (msg) => {
    if (!isAdmin(msg.from.id)) return;
    if (msg.document.mime_type.startsWith('video/')) {
        saveDraft(msg.from.id, 'video', msg.document.file_id);
        bot.sendMessage(msg.chat.id, '✅ Video qabul qilindi! Endi davom etishingiz mumkin:', { reply_markup: miniAppButton });
    } else if (msg.document.mime_type.startsWith('image/')) {
        saveDraft(msg.from.id, 'photo', msg.document.file_id);
        bot.sendMessage(msg.chat.id, '✅ Rasm qabul qilindi! Endi davom etishingiz mumkin:', { reply_markup: miniAppButton });
    }
});

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('No BOT_TOKEN found!');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

const CHANNEL_ID = '-1003584168498'; // From logs
const USER_ID = '8128002751';     // From logs

(async () => {
    console.log(`Checking membership for User ${USER_ID} in Channel ${CHANNEL_ID}...`);
    try {
        const member = await bot.getChatMember(CHANNEL_ID, USER_ID);
        console.log('Result:', JSON.stringify(member, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
        if (e.response && e.response.body) {
            console.error('Body:', JSON.stringify(e.response.body, null, 2));
        }
    }
})();

const db = require('../database/db');

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

module.exports = { isAdmin, isSuperAdmin, SUPER_ADMINS };

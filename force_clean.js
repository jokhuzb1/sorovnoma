const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'data/voting.db');

try {
    if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log('✅ voting.db deleted successfully.');
    } else {
        console.log('ℹ️ voting.db does not exist.');
    }
} catch (error) {
    console.error('❌ Failed to delete voting.db:', error.message);
    // If locked, we can't do much from Node if another Node process holds it.
    // But we will try to overwrite it?
}

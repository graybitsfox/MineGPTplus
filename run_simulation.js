require('dotenv').config(); // Load .env file variables
const Bot = require('./Bot');

// --- Single Bot Launch for Connection Testing ---

// For offline mode, the username from .env will be used.
// If .env specifies a password (online mode), this name is just for logging.
const BOT_NAME_FOR_TESTING = process.env.MINEGPT_USERNAME || 'TestBot';

console.log(`--- Starting a single bot [${BOT_NAME_FOR_TESTING}] for connection testing ---`);
console.log(`Target Server: ${process.env.MINEGPT_HOST}:${process.env.MINEGPT_PORT}`);
console.log(`Version: ${process.env.MINEGPT_VERSION}`);
console.log(`Auth Mode: ${process.env.MINEGPT_PASSWORD ? 'Microsoft (Online)' : 'Offline'}`);

const bot = new Bot(BOT_NAME_FOR_TESTING);
bot.start();

// Keep the process alive to see logs
process.stdin.resume();

function cleanup() {
    console.log("\n--- Shutting down bot ---");
    // You can add bot disconnect logic here if needed in the future
    process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

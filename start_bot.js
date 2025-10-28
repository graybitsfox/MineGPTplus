const Bot = require('./Bot');

// Get the bot's name from the command-line arguments
const botName = process.argv[2];

if (!botName) {
    console.error('Error: Bot name not provided. Usage: node start_bot.js <botName>');
    process.exit(1);
}

// Create and start the bot instance
console.log(`Initializing bot process for: ${botName}`);
const bot = new Bot(botName);
bot.start();

// Keep the process alive
process.stdin.resume();

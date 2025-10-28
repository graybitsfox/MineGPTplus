const Bot = require('./Bot');

const BOT_NAMES = ['Alice', 'Bob', 'Charlie', 'David'];
const SERVER_STARTUP_TIME = 5000; // 5 seconds for the server to initialize

function startBot(name) {
    const bot = new Bot(name);
    bot.start();
}

console.log(`Waiting ${SERVER_STARTUP_TIME / 1000} seconds for server to start...`);
setTimeout(() => {
    BOT_NAMES.forEach((name, i) => {
        // Stagger the bot startups to avoid all joining at the exact same time
        setTimeout(() => {
            console.log(`Starting bot: ${name}`);
            startBot(name);
        }, i * 2000); // 2 second delay between each bot
    });
}, SERVER_STARTUP_TIME);


// Keep the process alive
process.stdin.resume();

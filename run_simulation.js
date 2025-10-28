require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const Bot = require('./Bot');

const BOT_NAMES = ['Alice', 'Bob', 'Charlie', 'David'];
// A short delay to let the message bus initialize
const SERVER_STARTUP_TIME = 2000;

let childProcesses = [];

// Helper function to spawn and manage a child process
function runScript(scriptPath, name) {
    const fullPath = path.join(__dirname, scriptPath);
    const process = spawn('node', [fullPath]);

    process.stdout.on('data', (data) => {
        console.log(`[${name} STDOUT]: ${data.toString().trim()}`);
    });

    process.stderr.on('data', (data) => {
        console.error(`[${name} STDERR]: ${data.toString().trim()}`);
    });

    process.on('close', (code) => {
        console.log(`[${name}]: Child process exited with code ${code}`);
    });

    childProcesses.push(process);
    return process;
}

// 1. Start the Message Bus server
console.log("--- Starting Message Bus Server ---");
runScript('message_bus.js', 'MessageBus');

// 2. Start the bots after a short delay
console.log(`--- Waiting ${SERVER_STARTUP_TIME / 1000} seconds for the message bus to initialize ---`);
setTimeout(() => {
    console.log("--- Starting Bot Civilization ---");
    console.log(`Connecting to server: ${process.env.MINEGPT_HOST}:${process.env.MINEGPT_PORT}`);

    BOT_NAMES.forEach((name, i) => {
        setTimeout(() => {
            console.log(`Starting bot: ${name}`);
            const bot = new Bot(name);
            bot.start();
        }, i * 4000); // Stagger bot startups to avoid overwhelming the server login
    });
}, SERVER_STARTUP_TIME);


// Graceful shutdown
function cleanup() {
    console.log("\n--- Shutting down all processes ---");
    childProcesses.forEach(proc => {
        proc.kill();
    });
    process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

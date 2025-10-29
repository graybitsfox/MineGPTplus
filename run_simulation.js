require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

const BOT_NAMES = ['Alice', 'Bob', 'Charlie', 'David'];
const SERVER_STARTUP_TIME = 2000;

let childProcesses = [];

// Helper function to spawn and manage a child process
function runScript(scriptPath, name, args = []) {
    const fullPath = path.join(__dirname, scriptPath);
    const process = spawn('node', [fullPath, ...args]);

    const logPrefix = `[${name}]`;

    process.stdout.on('data', (data) => {
        data.toString().trim().split('\n').forEach(line => console.log(`${logPrefix} ${line}`));
    });

    process.stderr.on('data', (data) => {
        data.toString().trim().split('\n').forEach(line => console.error(`${logPrefix} [ERROR] ${line}`));
    });

    process.on('close', (code) => {
        console.log(`${logPrefix} Child process exited with code ${code}`);
    });

    childProcesses.push(process);
    return process;
}

// 1. Start the Message Bus server
console.log("--- Starting Message Bus Server ---");
runScript('message_bus.js', 'MessageBus');

// 2. Start the bot processes after a short delay
console.log(`--- Waiting ${SERVER_STARTUP_TIME / 1000} seconds for the message bus to initialize ---`);
setTimeout(() => {
    console.log("--- Launching Bot Processes ---");
    console.log(`Connecting to server: ${process.env.MINEGPT_HOST}:${process.env.MINEGPT_PORT}`);

    BOT_NAMES.forEach((name, i) => {
        setTimeout(() => {
            console.log(`--- Spawning process for bot: ${name} ---`);
            runScript('start_bot.js', name, [name]);
        }, i * 2000);
    });
}, SERVER_STARTUP_TIME);


// Graceful shutdown
function cleanup() {
    console.log("\n--- Shutting down all child processes ---");
    childProcesses.forEach(proc => {
        proc.kill();
    });
    process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

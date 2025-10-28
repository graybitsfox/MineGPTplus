const { spawn } = require('child_process');
const path = require('path');
const Bot = require('./Bot');

const BOT_NAMES = ['Alice', 'Bob', 'Charlie', 'David'];
const SERVER_STARTUP_TIME = 8000; // Increased to 8 seconds for more stability

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

// 1. Start the servers
console.log("--- Starting Servers ---");
runScript('message_bus.js', 'MessageBus');
runScript('server.js', 'MinecraftServer');

// 2. Start the bots after a delay
console.log(`--- Waiting ${SERVER_STARTUP_TIME / 1000} seconds for servers to initialize ---`);
setTimeout(() => {
    console.log("--- Starting Bots ---");
    BOT_NAMES.forEach((name, i) => {
        setTimeout(() => {
            console.log(`Starting bot: ${name}`);
            const bot = new Bot(name);
            bot.start();
        }, i * 2000); // Stagger bot startups
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

process.on('SIGINT', cleanup); // Catches Ctrl+C
process.on('SIGTERM', cleanup);

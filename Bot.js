const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');

class Bot {
    constructor(username, role) {
        this.username = username;
        this.role = role;
        this.host = process.env.MINEGPT_HOST || 'localhost';
        this.port = parseInt(process.env.MINEGPT_PORT) || 25565;
        this.version = process.env.MINEGPT_VERSION || '1.18.2';
        this.password = process.env.MINEGPT_PASSWORD;

        this.bot = null;
        this.mcData = null;
        this.ws = null;
        this.busy = false;

        this.LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log'];
    }

    log(message) {
        console.log(`[${this.username} | ${this.role}] ${message}`);
    }

    start() {
        this.log("Initializing...");
        this.bot = mineflayer.createBot({
            host: this.host,
            port: this.port,
            version: this.version,
            username: this.username,
            password: this.password,
            auth: this.password ? 'microsoft' : 'offline',
            logErrors: false,
            respawn: true,
            viewDistance: 'far',
            disableChatSigning: true
        });

        this.loadPlugins();
        this.addEventListeners();
        this.connectToMessageBus();
    }

    loadPlugins() {
        this.bot.loadPlugin(pathfinder);
        this.bot.loadPlugin(autoeatLoader);
    }

    connectToMessageBus() {
        this.ws = new WebSocket('ws://localhost:8080');
        this.ws.on('open', () => {
            this.log("Connected to Message Bus.");
            this.announceReadiness();
        });
        this.ws.on('message', message => this.handleMessage(JSON.parse(message.toString())));
        this.ws.on('close', () => {
            this.log("Disconnected from Message Bus. Reconnecting...");
            setTimeout(() => this.connectToMessageBus(), 5000);
        });
        this.ws.on('error', () => {});
    }

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ...data, from: this.username, role: this.role }));
        }
    }

    announceReadiness() {
        this.sendMessage({ event: 'ready_for_task' });
    }

    handleMessage(data) {
        // This will be implemented by subclasses
    }

    addEventListeners() {
        this.bot.on('kicked', (reason) => this.log(`Kicked for ${reason}!`));
        this.bot.on('error', (err) => this.log(`Error: ${err}`));
        this.bot.on('end', (reason) => {
            this.log(`Disconnected: ${reason}. Reconnecting...`);
            setTimeout(() => this.start(), 5000);
        });
        this.bot.on('respawn', () => this.log(`Respawned at ${this.bot.entity.position}`));
        this.bot.on('health', () => {
            if (this.bot.food === 20) this.bot.autoEat.disable();
            else this.bot.autoEat.enable();
        });

        this.bot.once('spawn', () => {
            this.log("Bot spawned.");
            this.mcData = require('minecraft-data')(this.bot.version);

            // **THE FIX IS HERE:** Call the onSpawn method that subclasses will implement.
            this.onSpawn();
        });
    }

    // This method is intended to be overridden by subclasses
    onSpawn() {
        this.log("Ready for tasks.");
        this.announceReadiness();
    }
}

module.exports = Bot;

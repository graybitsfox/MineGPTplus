const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');

class Bot {
    constructor(username) {
        this.username = username;
        this.host = process.env.MINEGPT_HOST || 'localhost';
        this.port = parseInt(process.env.MINEGPT_PORT) || 25565;
        this.version = process.env.MINEGPT_VERSION || '1.18.2';
        this.password = process.env.MINEGPT_PASSWORD;

        this.bot = null;
        this.mcData = null;
        this.ws = null;

        this.LOG_NAMES = []; // Will be populated after spawn
    }

    log(message) {
        console.log(`[${this.username}] ${message}`);
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
        this.ws.on('open', () => this.log("Connected to Message Bus."));
        this.ws.on('message', message => this.handleMessage(JSON.parse(message.toString())));
        this.ws.on('close', () => {
            this.log("Disconnected from Message Bus. Reconnecting...");
            setTimeout(() => this.connectToMessageBus(), 5000);
        });
        this.ws.on('error', () => { /* Ignore errors, handled by close */ });
    }

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    handleMessage(data) {
        // This method will be overridden by subclasses (e.g., Carpenter)
        this.log(`Received message: ${JSON.stringify(data)}`);
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
            this.LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log'];

            this.bot.autoEat.options = {
                priority: 'foodPoints',
                startAt: 18,
                bannedFood: []
            };

            // Allow subclasses to define their own spawn behavior
            this.onSpawn();
        });
    }

    // This will be implemented by subclasses
    onSpawn() {
        this.log("Ready for tasks.");
    }
}

module.exports = Bot; // Export the class

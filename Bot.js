const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const BOT_STATES = {
    INIT: 'INIT',
    CANDIDATE: 'CANDIDATE',
    VOTING: 'VOTING',
    WORKER_IDLE: 'WORKER_IDLE',
    WORKER_BUSY: 'WORKER_BUSY',
    ELDER: 'ELDER'
};

const ELECTION_TIMEOUT = 5000;
const VOTE_TIMEOUT = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;

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

        this.state = BOT_STATES.INIT;
        this.elder = null;
        this.candidates = new Set();
        this.votes = {};
        this.hasVoted = false;

        this.villageChestPosition = null;
        this.tasks = [];
        this.currentTask = null;
    }

    log(message) {
        console.log(`[${this.username} | ${this.state}] ${message}`);
    }

    start(retryCount = 0) {
        this.log(`Attempting to connect (try ${retryCount + 1}/${MAX_RETRIES})...`);

        const botOptions = {
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
        };

        this.bot = mineflayer.createBot(botOptions);

        this.bot.once('spawn', () => {
            this.log("Successfully connected and spawned.");
            this.loadPlugins();
            this.addEventListeners();
            this.connectToMessageBus();
        });

        this.bot.on('error', (err) => {
            if (err.code === 'ECONNREFUSED' && retryCount < MAX_RETRIES - 1) {
                this.log(`Connection refused. Retrying in ${RETRY_DELAY / 1000} seconds...`);
                setTimeout(() => this.start(retryCount + 1), RETRY_DELAY);
            } else {
                this.log(`Unhandled error: ${err}. Stopping.`);
            }
        });

        this.bot.on('end', (reason) => {
             this.log(`Disconnected: ${reason}.`);
             this.state = BOT_STATES.INIT;
        });
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
        this.ws.on('error', () => {});
    }

    // ... rest of the file is the same as before ...
    // sendMessage, handleMessage, addEventListeners (without spawn), etc.
    // ...
    // Note: I will need to remove the 'spawn' listener from addEventListeners
    // as it's now handled in the start() method.

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ...data, from: this.username }));
        }
    }

    handleMessage(data) {
        // --- Election Logic ---
        if (data.event === 'declare_candidate' && this.state === BOT_STATES.CANDIDATE) this.candidates.add(data.from);
        if (data.event === 'cast_vote' && this.state === BOT_STATES.VOTING) {
            if (!this.votes[data.vote]) this.votes[data.vote] = [];
            if (!Object.values(this.votes).flat().includes(data.from)) this.votes[data.vote].push(data.from);
        }
        if (data.event === 'election_result' && this.state === BOT_STATES.VOTING) {
            this.elder = data.elder;
            this.state = (this.username === this.elder) ? BOT_STATES.ELDER : BOT_STATES.WORKER_IDLE;
            this.log(`Election over. Elder is ${this.elder}. My new role is ${this.state}.`);
            this.onRoleAssigned();
        }
        if (data.event === 'restart_election') {
            this.log("Received signal to restart election due to a tie.");
            // Add a small random delay to prevent all bots starting at the exact same time
            setTimeout(() => this.startElection(), Math.random() * 1000);
        }

        // --- Elder Task Management ---
        if (this.state === BOT_STATES.ELDER) {
            if (data.event === 'task_accept') {
                const task = this.tasks.find(t => t.id === data.taskId);
                if (task && !task.assignedTo) {
                    task.assignedTo = data.from;
                    this.log(`Task ${task.id} assigned to ${data.from}.`);
                    this.announceTasks();
                }
            }
            if (data.event === 'task_complete') {
                this.tasks = this.tasks.filter(t => t.id !== data.taskId);
                this.log(`Task ${data.taskId} completed by ${data.from}. Remaining tasks: ${this.tasks.length}`);
            }
             if (data.event === 'task_fail') {
                const task = this.tasks.find(t => t.id === data.taskId);
                if (task) task.assignedTo = null;
                this.log(`Task ${data.taskId} failed by ${data.from}. Re-releasing.`);
                this.announceTasks();
            }
        }

        // --- Worker Task Handling ---
        if (this.state === BOT_STATES.WORKER_IDLE) {
            if (data.event === 'village_chest_location') {
                this.villageChestPosition = data.position;
                this.log(`Village chest location confirmed: ${JSON.stringify(this.villageChestPosition)}`);
            }
            if (data.event === 'task_announcement' && !this.currentTask) {
                const availableTask = data.tasks.find(t => !t.assignedTo);
                if (availableTask) {
                    this.acceptTask(availableTask);
                }
            }
        }
    }

    addEventListeners() {
        this.bot.on('kicked', (reason) => this.log(`Kicked for ${reason}!`));
        this.mcData = require('minecraft-data')(this.bot.version);
        const defaultMove = new Movements(this.bot, this.mcData);
        this.bot.pathfinder.setMovements(defaultMove);
        this.startElection();
    }

    startElection() {
        this.state = BOT_STATES.CANDIDATE;
        this.candidates = new Set([this.username]);
        this.votes = {};
        this.hasVoted = false;
        this.sendMessage({ event: 'declare_candidate' });
        setTimeout(() => {
            this.state = BOT_STATES.VOTING;
            this.castVote();
            setTimeout(() => this.tallyVotes(), VOTE_TIMEOUT);
        }, ELECTION_TIMEOUT);
    }

    castVote() {
        if (this.hasVoted) return;
        const otherCandidates = Array.from(this.candidates).filter(c => c !== this.username);
        const voteFor = otherCandidates.length > 0
            ? otherCandidates[Math.floor(Math.random() * otherCandidates.length)]
            : this.username;
        this.sendMessage({ event: 'cast_vote', vote: voteFor });
        this.hasVoted = true;
    }

    tallyVotes() {
        if (this.state !== BOT_STATES.VOTING) return;
        const clerk = Array.from(this.candidates).sort()[0];
        if (this.username !== clerk) return;

        let winningCandidate = null;
        let maxVotes = -1;
        let isTie = false;

        for (const candidate in this.votes) {
            const voteCount = this.votes[candidate].length;
            if (voteCount > maxVotes) {
                maxVotes = voteCount;
                winningCandidate = candidate;
                isTie = false;
            } else if (voteCount === maxVotes) {
                isTie = true;
            }
        }

        if (isTie || maxVotes <= 0) {
            this.log("Tie detected or no votes! Restarting election.");
            setTimeout(() => this.sendMessage({ event: 'restart_election' }), 1000);
            return;
        }

        this.sendMessage({ event: 'election_result', elder: winningCandidate });
    }

    onRoleAssigned() {
        if (this.state === BOT_STATES.ELDER) {
            this.log("I am the Elder. I will establish the village and manage tasks.");
            this.establishVillageCenter().then(() => {
                this.createNewTask('gather', { itemName: 'oak_log', count: 16 });
                this.announceTasks();
                setInterval(() => this.announceTasks(), 10000);
            });
        } else if (this.state === BOT_STATES.WORKER_IDLE) {
            this.log("I am a Worker. Awaiting village location and tasks.");
        }
    }

    async establishVillageCenter() {
        try {
            const chestPosition = this.bot.entity.position.floored().offset(2, 0, 0);
            await this.gatherItem('oak_log', 3);
            await this.craftItem('crafting_table', 1);
            const tablePos = this.bot.entity.position.floored().offset(0, 0, 2);
            await this.placeItem('crafting_table', tablePos);
            await this.gatherItem('oak_log', 8);
            await this.craftItem('chest', 1, tablePos);
            await this.placeItem('chest', chestPosition);
            this.sendMessage({ event: 'village_chest_location', position: chestPosition });
        } catch (err) {
            this.log(`Error establishing village center: ${err.message}`);
        }
    }

    async gatherItem(name, count) {
        const item = this.mcData.itemsByName[name];
        const blocks = this.bot.findBlocks({
            matching: (block) => block.name === name,
            maxDistance: 64,
            count: count
        });
        if (blocks.length < count) throw new Error(`Not enough ${name} nearby.`);
        for (let i = 0; i < count; i++) {
            await this.bot.pathfinder.goto(new GoalNear(blocks[i].x, blocks[i].y, blocks[i].z, 1));
            await this.bot.dig(this.bot.blockAt(blocks[i]));
        }
    }

    async craftItem(name, count, tablePos = null) {
        const item = this.mcData.itemsByName[name];
        let craftingTable = tablePos ? this.bot.blockAt(tablePos) : null;
        const recipe = this.bot.recipesFor(item.id, null, 1, craftingTable)[0];
        if (!recipe) throw new Error(`No recipe for ${name}`);
        await this.bot.craft(recipe, count, craftingTable);
    }

    async placeItem(name, position) {
        const item = this.mcData.itemsByName[name];
        const referenceBlock = this.bot.blockAt(position.offset(0, -1, 0));
        await this.bot.equip(item.id, 'hand');
        await this.bot.placeBlock(referenceBlock, { x: 0, y: 1, z: 0 });
    }

    acceptTask(task) {
        this.state = BOT_STATES.WORKER_BUSY;
        this.currentTask = task;
        this.log(`Accepting task: ${task.id}`);
        this.sendMessage({ event: 'task_accept', taskId: task.id });
        this.executeTask();
    }

    async executeTask() {
        try {
            const { type, details } = this.currentTask;
            if (type === 'gather') {
                await this.gatherItem(details.itemName, details.count);
                await this.depositItems(details.itemName, details.count);
            }
            this.log(`Task ${this.currentTask.id} finished.`);
            this.sendMessage({ event: 'task_complete', taskId: this.currentTask.id });
        } catch (err) {
            this.log(`Error executing task: ${err.message}. Re-releasing task.`);
            this.sendMessage({ event: 'task_fail', taskId: this.currentTask.id });
        } finally {
            this.currentTask = null;
            this.state = BOT_STATES.WORKER_IDLE;
        }
    }

    async depositItems(name, count) {
        if (!this.villageChestPosition) throw new Error("I don't know where the village chest is.");
        const chestPos = this.villageChestPosition;
        await this.bot.pathfinder.goto(new GoalNear(chestPos.x, chestPos.y, chestPos.z, 2));
        const chestBlock = this.bot.blockAt(chestPos);
        const chest = await this.bot.openChest(chestBlock);
        const itemToDeposit = this.mcData.itemsByName[name];
        await chest.deposit(itemToDeposit.id, null, count);
        await chest.close();
        this.log(`Deposited ${count}x ${name} into the village chest.`);
    }
}

module.exports = Bot;

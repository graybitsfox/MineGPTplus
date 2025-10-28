require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const BOT_STATES = {
    INIT: 'INIT', CANDIDATE: 'CANDIDATE', VOTING: 'VOTING',
    WORKER_IDLE: 'WORKER_IDLE', WORKER_BUSY: 'WORKER_BUSY', ELDER: 'ELDER'
};
const ELECTION_TIMEOUT = 5000;
const VOTE_TIMEOUT = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;
const INVENTORY_CHECK_INTERVAL = 20000;

class Bot {
    constructor(botName) {
        this.host = process.env.MINEGPT_HOST;
        this.port = parseInt(process.env.MINEGPT_PORT);
        this.version = process.env.MINEGPT_VERSION;
        this.username = process.env.MINEGPT_PASSWORD ? process.env.MINEGPT_USERNAME : botName;
        this.password = process.env.MINEGPT_PASSWORD || null;
        this.auth = this.password ? 'microsoft' : 'offline';
        this.bot = null;
        this.mcData = null;
        this.ws = null;
        this.state = BOT_STATES.INIT;
        this.elder = null;
        this.candidates = new Set();
        this.votes = {};
        this.hasVoted = false;
    this.villageChestPosition = null;
    this.villageInventory = {};
    // Use a generic 'log' goal so any wood log type satisfies the requirement
    this.villageGoals = { furnace: 4, log: 32 };
        this.tasks = [];
        this.currentTask = null;
        this.is_searching = false;
    }

    log(message) {
        console.log(`[${this.username} | ${this.state}] ${message}`);
    }

    start(retryCount = 0) {
        this.log(`Attempting to connect to ${this.host}:${this.port} (try ${retryCount + 1}/${MAX_RETRIES})...`);
        this.bot = mineflayer.createBot({
            host: this.host, port: this.port, version: this.version, username: this.username,
            password: this.password, auth: this.auth, logErrors: true, respawn: true,
            viewDistance: 'far', disableChatSigning: true
        });
        // If the underlying minecraft-protocol client's keepalive timeout is too short,
        // increase it after the client is created. Default observed timeout is 30000 ms.
        const desiredKeepAlive = parseInt(process.env.MINEGPT_KEEPALIVE_MS) || 60000;
        this.bot.once('spawn', () => {
            this.log("Successfully connected and spawned.");
            this.mcData = require('minecraft-data')(this.bot.version);
            // Try to increase keepalive timeout on the low-level client if available
            try {
                if (this.bot._client && typeof this.bot._client.keepAliveTimeout !== 'undefined') {
                    this.bot._client.keepAliveTimeout = desiredKeepAlive;
                    this.log(`Set underlying keepAliveTimeout to ${desiredKeepAlive}ms`);
                }
            } catch (e) {
                this.log(`Could not set keepAliveTimeout: ${e.message}`);
            }
            this.loadPlugins();
            this.addEventListeners();
            this.connectToMessageBus();
        });

        this.bot.on('error', (err) => {
             this.log(`Connection error: ${err}.`);
             // Handle keepalive/timeouts gracefully with an increased delay
             const isTimeout = err && err.message && err.message.toLowerCase().includes('timed out');
             if (isTimeout) {
                 this.log('Detected keepalive timeout; will retry with longer delay.');
             }
             if (retryCount < MAX_RETRIES - 1) {
                const delay = isTimeout ? RETRY_DELAY * 2 : RETRY_DELAY;
                setTimeout(() => this.start(retryCount + 1), delay);
             } else {
                 this.log(`All connection attempts failed. Stopping.`);
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
        const defaultMove = new Movements(this.bot, this.mcData);
        this.bot.pathfinder.setMovements(defaultMove);
    }

    connectToMessageBus() {
        this.ws = new WebSocket('ws://localhost:8080');
        this.ws.on('open', () => {
            this.log("Connected to Message Bus.");
            // Start election only if we don't already know the elder
            if (!this.elder) {
                this.startElection();
            } else {
                this.log(`Already know elder: ${this.elder} — skipping election.`);
            }
        });
        this.ws.on('message', message => this.handleMessage(JSON.parse(message.toString())));
        this.ws.on('close', () => setTimeout(() => this.connectToMessageBus(), 5000));
        this.ws.on('error', () => {});
    }

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ...data, from: this.username }));
        }
    }

    handleMessage(data) {
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
            setTimeout(() => this.startElection(), Math.random() * 1000);
        }
        if (this.state === BOT_STATES.ELDER) {
            if (data.event === 'task_accept') {
                const task = this.tasks.find(t => t.id === data.taskId);
                if (task && !task.assignedTo) task.assignedTo = data.from;
                this.announceTasks();
            }
            if (data.event === 'task_complete') {
                this.tasks = this.tasks.filter(t => t.id !== data.taskId);
                this.checkVillageInventory();
            }
             if (data.event === 'task_fail') {
                const task = this.tasks.find(t => t.id === data.taskId);
                if (task) task.assignedTo = null;
                this.announceTasks();
            }
        }
        if (this.state === BOT_STATES.WORKER_IDLE) {
            if (data.event === 'village_chest_location') this.villageChestPosition = data.position;
            if (data.event === 'task_announcement' && !this.currentTask) {
                const availableTask = data.tasks.find(t => !t.assignedTo);
                if (availableTask) this.acceptTask(availableTask);
            }
        }
    }

    addEventListeners() {
        this.bot.on('kicked', (reason) => this.log(`Kicked for ${reason}!`));
        this.startSelfDefense();
    }

    startSelfDefense() {
        this.bot.on('entityHurt', (entity) => {
            if (entity.id !== this.bot.entity.id) return; // Only react if this bot was hurt

            const attacker = this.bot.nearestEntity(e =>
                e.type === 'mob' &&
                e.kind === 'Hostile mobs' &&
                e.position.distanceTo(this.bot.entity.position) < 8
            );

            if (attacker) {
                this.log(`Under attack by a ${attacker.name}! Fighting back.`);
                this.bot.attack(attacker);
            }
        });
    }

    startElection() {
        // If we already have an elder, don't run another election
        if (this.elder) {
            this.log(`Elder already assigned (${this.elder}), skipping election.`);
            this.state = BOT_STATES.WORKER_IDLE;
            return;
        }

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
        const voteFor = otherCandidates.length > 0 ? otherCandidates[Math.floor(Math.random() * otherCandidates.length)] : this.username;
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
            this.sendMessage({ event: 'restart_election' });
        } else {
            this.sendMessage({ event: 'election_result', elder: winningCandidate });
        }
    }

    onRoleAssigned() {
        if (this.state === BOT_STATES.ELDER) {
            this.establishVillageCenter().then(() => {
                if (this.villageChestPosition) {
                    this.checkVillageInventory();
                    setInterval(() => this.checkVillageInventory(), INVENTORY_CHECK_INTERVAL);
                }
            });
        }
    }

    async establishVillageCenter() {
        if (this.is_searching) return;
        try {
            await this.gatherItem('log', 12);
            await this.craftPlanks();
            const chestPosition = this.bot.entity.position.floored().offset(2, 0, 0);
            this.villageChestPosition = chestPosition;
            const tablePos = this.bot.entity.position.floored().offset(0, 0, 2);
            await this.craftItem('crafting_table', 1);
            await this.placeItem('crafting_table', tablePos);
            await this.craftItem('chest', 1, tablePos);
            await this.placeItem('chest', chestPosition);
            this.sendMessage({ event: 'village_chest_location', position: chestPosition });
            this.log("Village center established successfully!");
        } catch (err) {
            this.log(`Could not establish village: ${err.message}. Trying to find nearby wood.`);
            // Instead of searching for a biome, try to find oak_log blocks nearby and move there
            this.is_searching = true;
            try {
                    const logs = this.bot.findBlocks({ matching: (b) => b && b.name === 'oak_log', maxDistance: 100, count: 12 });
                if (logs && logs.length > 0) {
                    // Move to the first found log and try again
                    const target = logs[0];
                    await this.bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, 3));
                    this.is_searching = false;
                    await this.establishVillageCenter();
                    return;
                }
                this.log("No oak_log found nearby. The Elder is giving up.");
            } catch (searchErr) {
                this.log(`Error while searching for wood: ${searchErr.message}`);
            } finally {
                this.is_searching = false;
            }
        }
    }

    async craftPlanks() {
        // Find any log type in inventory and craft corresponding planks.
        const plankItem = this.mcData.itemsByName.oak_planks;
        if (!plankItem) return;
        const recipes = this.bot.recipesFor(plankItem.id, null, 1, null) || [];
        // Try to find a log in inventory that matches one of the recipes
        for (const recipe of recipes) {
            // recipe.delta has negative ids for ingredients
            const ingredient = recipe.delta.find(d => d.count < 0);
            if (!ingredient) continue;
            const ingredientId = -ingredient.id;
            const logCount = this.bot.inventory.count(ingredientId, null);
            if (logCount > 0) {
                await this.bot.craft(recipe, logCount, null);
                return;
            }
        }
    }

    async checkVillageInventory() {
        if (!this.villageChestPosition) return;
        try {
            await this.goToChest();
            const chestBlock = this.bot.blockAt(this.villageChestPosition);
            if (!chestBlock || chestBlock.name !== 'chest') return;
            const chest = await this.bot.openChest(chestBlock);
            const summary = {};
            for (const item of chest.items()) {
                summary[item.name] = (summary[item.name] || 0) + item.count;
            }
            await chest.close();
            this.villageInventory = summary;
            this.evaluateGoals();
        } catch (err) {
            this.log(`Error during inventory check: ${err.message}`);
        }
    }

    evaluateGoals() {
        for (const itemName in this.villageGoals) {
            const requiredAmount = this.villageGoals[itemName];
            const currentAmount = this.villageInventory[itemName] || 0;
            const neededAmount = requiredAmount - currentAmount;
            if (neededAmount <= 0) continue;
            const existingTask = this.tasks.some(task => task.goal === itemName);
            if (existingTask) continue;
            const item = this.mcData.itemsByName[itemName];
            const recipes = this.bot.recipesFor(item.id, null, 1, null);
            if (recipes && recipes.length > 0) {
                const recipe = recipes[0];
                let canCraft = true;
                for (const ingredient of recipe.delta) {
                    if (ingredient.count > 0) continue;
                    const ingredientName = this.mcData.items[-ingredient.id].name;
                    const requiredIngredientCount = -ingredient.count * neededAmount;
                    const currentIngredientCount = this.villageInventory[ingredientName] || 0;
                    if (currentIngredientCount < requiredIngredientCount) {
                        canCraft = false;
                        const neededIngredientAmount = requiredIngredientCount - currentIngredientCount;
                        this.evaluateSubGoal(ingredientName, neededIngredientAmount, itemName);
                        break;
                    }
                }
                if (canCraft) {
                    this.createNewTask('craft', { itemName, count: neededAmount }, itemName);
                }
            } else {
                this.createNewTask('gather', { itemName, count: neededAmount }, itemName);
            }
        }
        this.announceTasks();
    }

    evaluateSubGoal(itemName, neededAmount, ultimateGoal) {
         const existingTask = this.tasks.some(task => task.details.itemName === itemName);
         if (!existingTask) {
            this.createNewTask('gather', { itemName, count: neededAmount }, ultimateGoal);
         }
    }

    createNewTask(type, details, goal) {
        const task = { id: uuidv4(), type, details, assignedTo: null, goal };
        this.tasks.push(task);
    }

    announceTasks() {
        this.sendMessage({ event: 'task_announcement', tasks: this.tasks });
    }

    acceptTask(task) {
        this.state = BOT_STATES.WORKER_BUSY;
        this.currentTask = task;
        this.sendMessage({ event: 'task_accept', taskId: task.id });
        this.executeTask();
    }

    async executeTask() {
        try {
            const { type, details } = this.currentTask;
            if (type === 'gather') {
                await this.gatherItem(details.itemName, details.count);
                await this.depositItems(details.itemName, details.count);
            } else if (type === 'craft') {
                await this.craftAndDepositItem(details.itemName, details.count);
            }
            this.sendMessage({ event: 'task_complete', taskId: this.currentTask.id });
        } catch (err) {
            this.sendMessage({ event: 'task_fail', taskId: this.currentTask.id });
        } finally {
            this.currentTask = null;
            this.state = BOT_STATES.WORKER_IDLE;
        }
    }

    async gatherItem(name, count) {
        const matching = (b) => {
            if (!b) return false;
            if (name === 'log') return b.name && b.name.includes('log');
            return b.name === name;
        };
        const blocks = this.bot.findBlocks({ matching, maxDistance: 64, count });
        if (blocks.length < count) throw new Error(`Not enough ${name} nearby.`);
        for (let i = 0; i < count; i++) {
            await this.bot.pathfinder.goto(new GoalNear(blocks[i].x, blocks[i].y, blocks[i].z, 1));
            await this.bot.dig(this.bot.blockAt(blocks[i]));
        }
    }

    async depositItems(name, count) {
        await this.goToChest();
        const chest = await this.bot.openChest(this.bot.blockAt(this.villageChestPosition));
        const item = this.mcData.itemsByName[name];
        await chest.deposit(item.id, null, count);
        await chest.close();
    }

    async craftAndDepositItem(name, count) {
        const item = this.mcData.itemsByName[name];
        const recipe = this.bot.recipesFor(item.id, null, 1, null)[0];
        await this.goToChest();
        let chest = await this.bot.openChest(this.bot.blockAt(this.villageChestPosition));
        for (const ing of recipe.delta) {
            if (ing.count > 0) continue;
            await chest.withdraw(-ing.id, null, -ing.count * count);
        }
        await chest.close();
        const table = this.bot.findBlock({ matching: this.mcData.blocksByName.crafting_table.id, maxDistance: 16 });
        await this.bot.pathfinder.goto(new GoalNear(table.position.x, table.position.y, table.position.z, 2));
        await this.bot.craft(recipe, count, table);
        await this.goToChest();
        chest = await this.bot.openChest(this.bot.blockAt(this.villageChestPosition));
        await chest.deposit(item.id, null, count);
        await chest.close();
    }

    async placeItem(name, position) {
        const item = this.mcData.itemsByName[name];
        await this.bot.equip(item.id, 'hand');
        await this.bot.placeBlock(this.bot.blockAt(position.offset(0, -1, 0)), { x: 0, y: 1, z: 0 });
    }

    async craftItem(name, count, tablePos = null) {
        const item = this.mcData.itemsByName[name];
        let table = tablePos ? this.bot.blockAt(tablePos) : null;
        const recipe = this.bot.recipesFor(item.id, null, 1, table)[0];
        if(!recipe) throw new Error(`No recipe for ${name}`);
        await this.bot.craft(recipe, count, table);
    }

    async goToChest() {
        if (!this.villageChestPosition) throw new Error("I don't know where the chest is.");
        await this.bot.pathfinder.goto(new GoalNear(this.villageChestPosition.x, this.villageChestPosition.y, this.villageChestPosition.z, 2));
    }

    async findBiome(name = 'forest') {
        this.log(`Searching for a ${name} biome...`);
        const options = {
            matching: (block) => {
                if (!block || !block.position) return false;
                if (!this.bot.world || typeof this.bot.world.getBiome !== 'function') return false;
                const biome = this.bot.world.getBiome(block.position);
                return biome && biome.name && biome.name.includes(name);
            },
            maxDistance: 100,
            count: 1,
        };
        const block = await this.bot.findBlock(options);
        if (block) return block.position;
        return null;
    }
}

module.exports = Bot;

require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const BOT_STATES = {
    INIT: 'INIT', CANDIDATE: 'CANDIDATE', VOTING: 'VOTING',
    WORKER_IDLE: 'WORKER_IDLE', WORKER_BUSY: 'WORKER_BUSY', ELDER: 'ELDER'
};
const ELECTION_TIMEOUT = 5000;
const VOTE_TIMEOUT = 5000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;
const INVENTORY_CHECK_INTERVAL = 10000;
const STATE_FILE = path.join(__dirname, 'village_state.json');
const TASK_CHUNK_SIZE = 16;

class Bot {
    constructor(botName) {
        this.host = process.env.MINEGPT_HOST;
        this.port = parseInt(process.env.MINEGPT_PORT);
        this.version = process.env.MINEGPT_VERSION;
        this.username = process.env.MINEGPT_PASSWORD ? process.env.MINEGPT_USERNAME : botName;
        this.password = process.env.MINEGPT_PASSWORD || null;
        this.auth = this.password ? 'microsoft' : 'offline';
        this.botName = botName;
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
        this.tasks = [];
        this.currentTask = null;
        this.is_searching = false;

        this.techLevel = 1;
        this.goalTemplates = {
            1: { furnace: 1 },
            2: { iron_pickaxe: 1 },
            3: { build_warehouse: true }
        };
        this.villageGoals = { ...this.goalTemplates[1] };

        this.blueprints = {
            warehouse: {
                materials: { oak_planks: 28 },
                schematic: [
                    { pos: [-1, 0, -1], type: 'oak_planks' }, { pos: [0, 0, -1], type: 'oak_planks' }, { pos: [1, 0, -1], type: 'oak_planks' },
                    { pos: [-1, 0, 0], type: 'oak_planks' }, { pos: [1, 0, 0], type: 'oak_planks' },
                    { pos: [-1, 0, 1], type: 'oak_planks' }, { pos: [0, 0, 1], type: 'oak_planks' }, { pos: [1, 0, 1], type: 'oak_planks' },
                    { pos: [-1, 1, -1], type: 'oak_planks' }, { pos: [0, 1, -1], type: 'oak_planks' }, { pos: [1, 1, -1], type: 'oak_planks' },
                    { pos: [-1, 1, 0], type: 'oak_planks' }, { pos: [1, 1, 0], type: 'oak_planks' },
                    { pos: [-1, 1, 1], type: 'oak_planks' }, { pos: [0, 1, 1], type: 'oak_planks' }, { pos: [1, 1, 1], type: 'oak_planks' },
                    { pos: [-1, 2, -1], type: 'oak_planks' }, { pos: [0, 2, -1], type: 'oak_planks' }, { pos: [1, 2, -1], type: 'oak_planks' },
                    { pos: [-1, 2, 0], type: 'oak_planks' }, { pos: [0, 2, 0], type: 'oak_planks' }, { pos: [1, 2, 0], type: 'oak_planks' },
                    { pos: [-1, 2, 1], type: 'oak_planks' }, { pos: [0, 2, 1], type: 'oak_planks' }, { pos: [1, 2, 1], type: 'oak_planks' },
                ]
            }
        };
    }

    log(message) {
        console.log(`[${this.botName} | ${this.state}] ${message}`);
    }

    async start(retryCount = 0) {
        try {
            const stateData = await fs.readFile(STATE_FILE, 'utf8');
            const state = JSON.parse(stateData);
            if (state.elder) this.elder = state.elder;
        } catch (error) {
            await fs.writeFile(STATE_FILE, JSON.stringify({}));
        }

        this.log(`Attempting to connect to ${this.host}:${this.port}...`);
        this.bot = mineflayer.createBot({
            host: this.host, port: this.port, version: this.version, username: this.username,
            password: this.password, auth: this.auth, logErrors: true, respawn: true,
            viewDistance: 'far', disableChatSigning: true
        });

        this.bot.once('spawn', () => {
            this.log("Successfully connected and spawned.");
            this.mcData = require('minecraft-data')(this.bot.version);
            this.loadPlugins();
            this.addEventListeners();
            this.connectToMessageBus();
        });

        this.bot.on('error', (err) => {
             if (err.code === 'ECONNREFUSED' && retryCount < MAX_RETRIES - 1) {
                setTimeout(() => this.start(retryCount + 1), RETRY_DELAY);
             } else {
                 this.log(`Connection error: ${err}. Stopping.`);
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
            if (this.elder) {
                this.state = (this.botName === this.elder) ? BOT_STATES.ELDER : BOT_STATES.WORKER_IDLE;
                this.onRoleAssigned();
            } else {
                this.startElection();
            }
        });
        this.ws.on('message', message => this.handleMessage(JSON.parse(message.toString())));
        this.ws.on('close', () => setTimeout(() => this.connectToMessageBus(), 5000));
        this.ws.on('error', () => {});
    }

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ ...data, from: this.botName }));
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
            this.state = (this.botName === this.elder) ? BOT_STATES.ELDER : BOT_STATES.WORKER_IDLE;
            this.onRoleAssigned();
        }
        if (data.event === 'restart_election') {
            setTimeout(() => this.startElection(), Math.random() * 1000);
        }
        if (this.state === BOT_STATES.ELDER) {
            const task = this.tasks.find(t => t.id === data.taskId);
            if (!task) return;
            if (data.event === 'task_progress') {
                task.details.progress += data.amount;
                if (task.details.progress >= task.details.required) {
                    this.tasks = this.tasks.filter(t => t.id !== task.id);
                    this.checkVillageInventory();
                }
            }
        }
        if (this.state === BOT_STATES.WORKER_IDLE) {
            if (data.event === 'village_chest_location') this.villageChestPosition = data.position;
            if (data.event === 'task_announcement' && !this.currentTask) {
                const availableTask = data.tasks.find(t => t.details.progress < t.details.required);
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
            if (entity.id !== this.bot.entity.id) return;
            const attacker = this.bot.nearestEntity(e => e.type === 'mob' && e.kind === 'Hostile mobs' && e.position.distanceTo(this.bot.entity.position) < 8);
            if (attacker) this.bot.attack(attacker);
        });
    }

    startElection() {
        this.state = BOT_STATES.CANDIDATE;
        this.candidates = new Set([this.botName]);
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
        const otherCandidates = Array.from(this.candidates).filter(c => c !== this.botName);
        const voteFor = otherCandidates.length > 0 ? otherCandidates[Math.floor(Math.random() * otherCandidates.length)] : this.botName;
        this.sendMessage({ event: 'cast_vote', vote: voteFor });
        this.hasVoted = true;
    }

    async tallyVotes() {
        if (this.state !== BOT_STATES.VOTING) return;
        const clerk = Array.from(this.candidates).sort()[0];
        if (this.botName !== clerk) return;
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
            this.elder = winningCandidate;
            await this.saveState();
        }
    }

    onRoleAssigned() {
        if (this.state === BOT_STATES.ELDER) {
            this.checkVillageInventory();
            setInterval(() => this.checkVillageInventory(), INVENTORY_CHECK_INTERVAL);
        }
    }

    async saveState() {
        try {
            await fs.writeFile(STATE_FILE, JSON.stringify({ elder: this.elder }, null, 2));
        } catch (error) {
            this.log(`Failed to save state: ${error}`);
        }
    }

    async establishVillageCenter() {
        if (!this.villageChestPosition) {
            const requiredLogs = 12;
            const currentLogs = this.villageInventory.oak_log || 0;
            if (currentLogs < requiredLogs) {
                const existingTask = this.tasks.some(task => task.goal === 'establish_village');
                if (!existingTask) {
                    this.createNewTask('gather', { itemName: 'oak_log', count: requiredLogs - currentLogs }, 'establish_village');
                    this.announceTasks();
                }
                return;
            }
        }

        try {
            await this.craftPlanks();
            const chestPosition = this.bot.entity.position.floored().offset(2, 0, 0);
            this.villageChestPosition = chestPosition;
            const tablePos = this.bot.entity.position.floored().offset(0, 0, 2);
            await this.craftItem('crafting_table', 1);
            await this.placeItem('crafting_table', tablePos);
            await this.craftItem('chest', 1, tablePos);
            await this.placeItem('chest', chestPosition);
            this.sendMessage({ event: 'village_chest_location', position: chestPosition });
            this.tasks = this.tasks.filter(t => t.goal !== 'establish_village');
        } catch (err) {
            this.log(`Elder failed to build village: ${err.message}. Will re-evaluate.`);
        }
    }

    async craftPlanks() {
        const logItem = this.mcData.itemsByName.oak_log;
        const logCount = this.bot.inventory.count(logItem.id, null);
        if (logCount > 0) {
            const plankItem = this.mcData.itemsByName.oak_planks;
            const recipe = this.bot.recipesFor(plankItem.id, null, 1, null)[0];
            if (!recipe) throw new Error("Could not find recipe for planks.");
            await this.bot.craft(recipe, logCount, null);
        }
    }

    async checkVillageInventory() {
        if (this.state !== BOT_STATES.ELDER) return;
        try {
            if (this.villageChestPosition) {
                await this.goToChest();
                const chestBlock = this.bot.blockAt(this.villageChestPosition);
                if (chestBlock && chestBlock.name === 'chest') {
                    const chest = await this.bot.openChest(chestBlock);
                    const summary = {};
                    for (const item of chest.items()) {
                        summary[item.name] = (summary[item.name] || 0) + item.count;
                    }
                    await chest.close();
                    this.villageInventory = summary;
                } else {
                    this.villageChestPosition = null;
                    this.villageInventory = {};
                }
            } else {
                 this.villageInventory = {};
            }
            if (!this.villageChestPosition) {
                this.establishVillageCenter();
            } else {
                this.evaluateGoals();
            }
        } catch (err) {
            this.log(`Error during inventory check: ${err.message}`);
        }
    }

    evaluateGoals() {
        if (this.checkIfGoalsAreMet()) {
            this.advanceTechLevel();
        }
        for (const goalName in this.villageGoals) {
            const required = this.villageGoals[goalName];
            if (goalName === 'build_warehouse' && required === true) {
                const blueprint = this.blueprints.warehouse;
                let materialsMet = true;
                for (const material in blueprint.materials) {
                    const requiredAmount = blueprint.materials[material];
                    const currentAmount = this.villageInventory[material] || 0;
                    if (currentAmount < requiredAmount) {
                        materialsMet = false;
                        this.evaluateSubGoal(material, requiredAmount - currentAmount, goalName);
                        break;
                    }
                }
                if (materialsMet) {
                    for (const block of blueprint.schematic) {
                         const blockPos = this.villageChestPosition.plus(block.pos);
                         if (this.bot.blockAt(blockPos).name !== block.type) {
                            const existingTask = this.tasks.some(t => t.type === 'build' && t.details.position.equals(blockPos));
                            if (!existingTask) {
                                this.createNewTask('build', { position: blockPos, type: block.type }, goalName);
                            }
                         }
                    }
                }
            } else {
                const currentAmount = this.villageInventory[goalName] || 0;
                const neededAmount = required - currentAmount;
                if (neededAmount <= 0) continue;
                const existingTask = this.tasks.some(task => task.goal === goalName);
                if (existingTask) continue;
                const item = this.mcData.itemsByName[goalName];
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
                            this.evaluateSubGoal(ingredientName, requiredIngredientCount - currentIngredientCount, goalName);
                            break;
                        }
                    }
                    if (canCraft) {
                        this.createNewTask('craft', { itemName: goalName, count: neededAmount }, goalName);
                    }
                } else {
                    this.createNewTask('gather', { itemName: goalName, count: neededAmount }, goalName);
                }
            }
        }
        this.announceTasks();
    }

    checkIfGoalsAreMet() {
        for (const itemName in this.villageGoals) {
            const requiredAmount = this.villageGoals[itemName];
            if(itemName === 'build_warehouse' && requiredAmount === true) {
                // Simplified check: assume goal is met if there are no more build tasks for it
                const buildTasksLeft = this.tasks.some(t => t.goal === 'build_warehouse');
                if(buildTasksLeft) return false;
            } else {
                const currentAmount = this.villageInventory[itemName] || 0;
                if (currentAmount < requiredAmount) return false;
            }
        }
        return true;
    }

    advanceTechLevel() {
        const nextLevel = this.techLevel + 1;
        if (this.goalTemplates[nextLevel]) {
            this.techLevel = nextLevel;
            this.villageGoals = { ...this.goalTemplates[this.techLevel] };
        } else {
            this.villageGoals = {};
        }
    }

    evaluateSubGoal(itemName, neededAmount, ultimateGoal) {
         const existingTask = this.tasks.some(task => task.goal === ultimateGoal && task.details.itemName === itemName);
         if (!existingTask) {
            this.createNewTask('gather', { itemName, count: neededAmount }, ultimateGoal);
         }
    }

    createNewTask(type, details, goal) {
        const task = { id: uuidv4(), type, goal, details: { ...details, progress: 0, required: details.count }, assignedWorkers: new Set()};
        this.tasks.push(task);
    }

    announceTasks() {
        this.sendMessage({ event: 'task_announcement', tasks: this.tasks });
    }

    acceptTask(task) {
        this.state = BOT_STATES.WORKER_BUSY;
        const remaining = task.details.required - task.details.progress;
        const amountToTake = Math.min(remaining, TASK_CHUNK_SIZE);
        this.currentTask = { id: task.id, type: task.type, details: { itemName: task.details.itemName, count: amountToTake } };
        if(task.type === 'build') this.currentTask.details = task.details;
        this.executeTask();
    }

    async executeTask() {
        try {
            const { type, details } = this.currentTask;
            let amountCompleted = details.count || 1;
            if (type === 'gather') {
                await this.upgradeTool();
                await this.gatherItem(details.itemName, details.count);
                await this.depositItems(details.itemName, details.count);
            } else if (type === 'craft') {
                await this.craftAndDepositItem(details.itemName, details.count);
            } else if (type === 'build') {
                await this.buildBlock(details.position, details.type);
            }
            this.sendMessage({ event: 'task_progress', taskId: this.currentTask.id, amount: amountCompleted });
        } catch (err) {
             this.log(`Error on task ${this.currentTask.id}: ${err.message}.`);
        } finally {
            this.currentTask = null;
            this.state = BOT_STATES.WORKER_IDLE;
        }
    }

    async upgradeTool() {
        if (!this.villageChestPosition) return;
        const toolHierarchy = ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
        try {
            await this.goToChest();
            const chest = await this.bot.openChest(this.bot.blockAt(this.villageChestPosition));
            let bestToolInChest = null;
            for (const toolName of toolHierarchy) {
                const toolItem = this.mcData.itemsByName[toolName];
                if (chest.findInventoryItem(toolItem.id, null)) {
                    bestToolInChest = toolName;
                    break;
                }
            }
            if (!bestToolInChest) {
                await chest.close();
                return;
            }
            let currentBestTool = null;
            for (const toolName of toolHierarchy) {
                 const toolItem = this.mcData.itemsByName[toolName];
                 if(this.bot.inventory.findInventoryItem(toolItem.id, null)) {
                     currentBestTool = toolName;
                     break;
                 }
            }
            const shouldUpgrade = !currentBestTool || toolHierarchy.indexOf(bestToolInChest) < toolHierarchy.indexOf(currentBestTool);
            if (shouldUpgrade) {
                if (currentBestTool) {
                    await chest.deposit(this.mcData.itemsByName[currentBestTool].id, null, 1);
                }
                await chest.withdraw(this.mcData.itemsByName[bestToolInChest].id, null, 1);
            }
            await chest.close();
        } catch (err) {
            this.log(`Error trying to upgrade tool: ${err.message}`);
        }
    }

    async gatherItem(name, count) {
        const blocks = this.bot.findBlocks({ matching: (b) => b.name === name, maxDistance: 64, count });
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

    async buildBlock(position, type) {
        await this.goToChest();
        const chest = await this.bot.openChest(this.bot.blockAt(this.villageChestPosition));
        const item = this.mcData.itemsByName[type];
        if (!item) throw new Error(`I don't know what a ${type} is.`);
        await chest.withdraw(item.id, null, 1);
        await chest.close();
        const referenceBlock = this.bot.blockAt(position.offset(0, -1, 0));
        await this.bot.pathfinder.goto(new GoalNear(referenceBlock.position.x, referenceBlock.position.y, referenceBlock.position.z, 2));
        await this.bot.equip(item.id, 'hand');
        await this.bot.placeBlock(referenceBlock, { x: 0, y: 1, z: 0 });
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

    async findResource(itemName) {
        const searchRadii = [64, 128, 256, 512];
        for (const radius of searchRadii) {
            const item = this.mcData.itemsByName[itemName];
            if (!item) return null;
            const block = await this.bot.findBlock({ matching: item.id, maxDistance: radius });
            if (block) return block.position;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return null;
    }
}

module.exports = Bot;

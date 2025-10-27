require('dotenv').config();
const Bot = require('./Bot');
const { GoalNear } = require('mineflayer-pathfinder').goals;

class Carpenter extends Bot {
    constructor() {
        super('Carpenter');
        this.sharedChestLocation = null;
        this.taskQueue = ['create_shared_chest'];
        this.busy = false;
    }

    onSpawn() {
        this.log("Ready to work. Starting initial setup.");
        this.startMainLoop();
    }

    startMainLoop() {
        if (this.taskQueue.length > 0) {
            this.runNextTask();
        }
    }

    async runNextTask() {
        if (this.busy) return;
        if (this.taskQueue.length === 0) {
            this.log("Initial setup complete. Now listening for tasks.");
            return;
        }

        const task = this.taskQueue.shift();
        this.log(`Starting task: ${task}`);
        this.busy = true;
        try {
            switch (task) {
                case 'create_shared_chest':
                    await this.createSharedChest();
                    break;
            }
            this.log(`Task ${task} completed.`);
        } catch (error) {
            this.log(`Task ${task} failed: ${error}`);
        }
        this.busy = false;
        this.startMainLoop();
    }

    async handleMessage(data) {
        if (this.taskQueue.length > 0) return;

        if (data.event === 'wood_deposited' && !this.busy) {
            this.log("Wood is ready. Starting crafting task.");
            // Logic for processing wood from the shared chest will go here
        }
    }

    async createSharedChest() {
        await this.getWood(3);
        await this.craftPlanks();
        await this.craftChest();
        await this.placeChest();

        // Announce the chest location to all bots
        this.sendMessage({
            event: 'shared_chest_created',
            location: this.sharedChestLocation
        });
        this.log("Broadcasted chest location.");
    }

    async getWood(count) {
        const logIds = this.LOG_NAMES.map(name => this.mcData.blocksByName[name].id);
        const targetBlock = this.bot.findBlock({ matching: logIds, maxDistance: 64 });
        if (!targetBlock) throw new Error("No wood found to create chest.");

        await this.bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));

        for (let i = 0; i < count; i++) {
            const nextLog = this.bot.findBlock({ matching: logIds, maxDistance: 3 });
            if (nextLog) await this.bot.dig(nextLog);
        }
    }

    async craftPlanks() {
        const logs = this.bot.inventory.items().filter(item => this.LOG_NAMES.includes(item.name));
        if (logs.length === 0) throw new Error("No logs to craft planks.");

        const logCount = logs.reduce((acc, item) => acc + item.count, 0);
        const logType = logs[0].type;
        const plankName = this.mcData.items[logType].name.replace('_log', '_planks');
        const plankId = this.mcData.itemsByName[plankName].id;
        const recipe = this.bot.recipesFor(plankId, null, 1, null)[0];

        await this.bot.craft(recipe, logCount, null);
    }

    async craftChest() {
        const plankName = this.LOG_NAMES[0].replace('_log', '_planks');
        const planks = this.bot.inventory.findInventoryItem(this.mcData.itemsByName[plankName].id, null);
        if (!planks || planks.count < 8) throw new Error("Not enough planks to craft a chest.");

        const chestId = this.mcData.itemsByName.chest.id;
        const recipe = this.bot.recipesFor(chestId, null, 1, null)[0];
        if (!recipe) throw new Error("No recipe for chest found.");

        await this.bot.craft(recipe, 1, null);
    }

    async placeChest() {
        const chest = this.bot.inventory.findInventoryItem(this.mcData.itemsByName.chest.id, null);
        if (!chest) throw new Error("No chest in inventory to place.");

        const referenceBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
        const placePosition = await this.bot.findPlaceablePosition(referenceBlock.position, 4);
        if (!placePosition) throw new Error("Could not find a place to put the chest.");

        await this.bot.equip(chest, 'hand');
        await this.bot.placeBlock(this.bot.blockAt(placePosition), { x: 0, y: 1, z: 0 });

        this.sharedChestLocation = placePosition.offset(0,1,0);
        this.log(`Shared chest placed at ${this.sharedChestLocation}`);
    }
}

const carpenter = new Carpenter();
carpenter.start();

require('dotenv').config();
const Bot = require('./Bot');
const { GoalNear } = require('mineflayer-pathfinder').goals;

const CHEST_POSITION = { x: 10, y: 64, z: 10 }; // Must be the same as Lumberjack's

class Carpenter extends Bot {
    constructor() {
        super('Carpenter');
        this.busy = false;
    }

    onSpawn() {
        this.log("Ready to craft. Waiting for wood.");
    }

    async handleMessage(data) {
        if (data.event === 'wood_deposited' && !this.busy) {
            this.log("Wood is ready. Starting crafting task.");
            this.busy = true;
            try {
                await this.processWood();
                this.log("Finished processing wood.");
            } catch (error) {
                this.log(`Could not process wood: ${error}`);
            }
            this.busy = false;
        }
    }

    async processWood() {
        await this.bot.pathfinder.goto(new GoalNear(CHEST_POSITION.x, CHEST_POSITION.y, CHEST_POSITION.z, 2));

        const chestBlock = this.bot.blockAt(this.bot.entity.position.offset(CHEST_POSITION.x, CHEST_POSITION.y, CHEST_POSITION.z));
        if (!chestBlock || !chestBlock.name.includes('chest')) {
            throw new Error("Chest not found at the specified location.");
        }

        const chest = await this.bot.openChest(chestBlock);
        this.log("Opened chest. Withdrawing logs.");

        // Withdraw all logs
        for (const item of chest.containerItems()) {
            if (this.LOG_NAMES.includes(item.name)) {
                await chest.withdraw(item.type, null, item.count);
            }
        }
        await chest.close();

        this.log("Withdrew logs. Now crafting planks.");
        await this.craftPlanks();
    }

    async craftPlanks() {
        const logs = this.bot.inventory.items().filter(item => this.LOG_NAMES.includes(item.name));
        if (logs.length === 0) {
            this.log("No logs to craft. Task complete.");
            return;
        }

        const logCount = logs.reduce((acc, item) => acc + item.count, 0);
        this.log(`Found ${logCount} logs. Crafting them into planks.`);

        const logType = logs[0].type;
        const plankName = this.mcData.items[logType].name.replace('_log', '_planks');
        const plankId = this.mcData.itemsByName[plankName].id;

        const recipe = this.bot.recipesFor(plankId, null, 1, null)[0];
        if (!recipe) throw new Error(`No recipe found for ${plankName}.`);

        await this.bot.craft(recipe, logCount, null);
        this.log(`Successfully crafted ${logCount * 4} planks.`);
    }
}

const carpenter = new Carpenter();
carpenter.start();

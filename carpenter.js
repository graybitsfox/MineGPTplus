require('dotenv').config();
const Bot = require('./Bot');
const { GoalNear } = require('mineflayer-pathfinder').goals;

class Carpenter extends Bot {
    constructor() {
        super('Carpenter', 'Carpenter');
        this.busy = false;
    }

    onSpawn() {
        this.log("Ready to craft. Waiting for dropped wood notifications.");
    }

    handleMessage(data) {
        if (data.event === 'wood_dropped' && !this.busy) {
            this.log(`Wood drop reported at ${JSON.stringify(data.location)}. Going to collect.`);
            this.collectAndProcessWood(data.location);
        }
    }

    async collectAndProcessWood(location) {
        this.busy = true;
        try {
            await this.bot.pathfinder.goto(new GoalNear(location.x, location.y, location.z, 2));

            // Wait a moment for the bot to auto-pickup any items it walked over
            await this.bot.waitForTicks(20);

            const logsInInventory = this.bot.inventory.items().some(item => this.LOG_NAMES.includes(item.name));
            if (!logsInInventory) {
                throw new Error("Failed to pick up any logs.");
            }

            this.log("Collected logs. Now crafting planks.");
            await this.craftPlanks();

        } catch (error) {
            this.log(`Failed to process wood: ${error}`);
        }
        this.busy = false;
        this.announceReadiness(); // Announce readiness for the next drop
    }

    async craftPlanks() {
        const logs = this.bot.inventory.items().filter(item => this.LOG_NAMES.includes(item.name));
        if (logs.length === 0) return;

        const logCount = logs.reduce((acc, item) => acc + item.count, 0);

        const logType = logs[0].type;
        const plankName = this.mcData.items[logType].name.replace('_log', '_planks');
        const plankId = this.mcData.itemsByName[plankName].id;

        const recipe = this.bot.recipesFor(plankId, null, 1, null)[0];
        if (!recipe) throw new Error(`No recipe for ${plankName}.`);

        await this.bot.craft(recipe, logCount, null);
        this.log(`Successfully crafted ${logCount * 4} planks.`);
    }
}

const carpenter = new Carpenter();
carpenter.start();

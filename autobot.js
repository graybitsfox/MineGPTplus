/*
* AutoBot v1.0
* Description: An autonomous mineflayer bot.
*/

// Import the required libraries
require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const autoeat = require('mineflayer-auto-eat').plugin

// Log a message to the console
function log(message){
    console.log(`[ AutoBot.js ] ${message}`)
}

// Log the initialization
log("Initializing AutoBot")

// ENV Variables
const mineflayerConfig = {
    host: process.env.MINEGPT_HOST,
    port: process.env.MINEGPT_PORT,
    version: process.env.MINEGPT_VERSION,
    auth: process.env.MINEGPT_AUTH,
    username: 'AutoBot', // Using a different username
    password: process.env.MINEGPT_PASSWORD,
    logErrors: false,
    respawn: true,
    viewDistance: 'far',
    disableChatSigning: true
}

let bot = null;

/*
* Creates the bot
*/
function createBot(){
    try{
        bot = mineflayer.createBot(mineflayerConfig)
        log("Bot created!")
    }
    catch(err){
        log(`Error: ${err}`)
        log("Retrying in 10 seconds...")
        setTimeout(createBot, 10000)
    }
}

// Create the bot
createBot()

// Load plugins
bot.loadPlugin(pathfinder)
bot.loadPlugin(autoeat)

// --- Constants and Bot State ---
let mcData;
const LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'acacia_log', 'jungle_log'];

// Add event listeners
bot.on('kicked', (reason) => log(`Kicked for ${reason}!`))
bot.on('error', (err) => log(`Error: ${err}`))
bot.on('end', createBot) // Attempt to reconnect on disconnect
bot.on('respawn', () => log(`Respawned at ${bot.entity.position}`))

bot.once('spawn', () => {
    log("Bot spawned. Ready to work.");

    // Load minecraft-data
    mcData = require('minecraft-data')(bot.version);

    // Setup auto-eat
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 18,
      bannedFood: []
    }

    // Initialize the task manager
    initializeTaskManager();
});

// --- Task Manager ---
const taskQueue = ['get_wood', 'craft_planks'];
let currentTask = null;
let busy = false;

function initializeTaskManager() {
    log("Task Manager initialized.");
    runNextTask();
}

async function runNextTask() {
    if (busy) return;
    if (taskQueue.length === 0) {
        log("All tasks completed.");
        bot.chat("I'm done with my tasks!");
        return;
    }

    currentTask = taskQueue.shift();
    log(`Starting task: ${currentTask}`);
    busy = true;

    try {
        switch (currentTask) {
            case 'get_wood':
                await getWood(3); // Get 3 logs
                break;
            case 'craft_planks':
                await craftPlanks();
                break;
        }
        log(`Task ${currentTask} completed successfully.`);
    } catch (error) {
        log(`Task ${currentTask} failed: ${error}`);
    }

    busy = false;
    setTimeout(runNextTask, 1000);
}

// --- Task Implementations ---

/**
 * Finds and collects a specified number of wood logs.
 * @param {number} count - The number of logs to collect.
 */
async function getWood(count) {
    const logIds = LOG_NAMES.map(name => mcData.blocksByName[name].id);
    const targetBlock = bot.findBlock({ matching: logIds, maxDistance: 64 });
    if (!targetBlock) throw new Error("No wood found nearby.");

    log(`Found wood at ${targetBlock.position}. Going to it.`);
    await bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));

    log(`Arrived at wood. Mining ${count} logs.`);
    for (let i = 0; i < count; i++) {
        // Find the next log in the tree trunk
        const nextLog = bot.findBlock({ matching: logIds, maxDistance: 2, referenceBlock: targetBlock.position.offset(0,i,0) });
        if(nextLog) {
            await bot.dig(nextLog);
            log(`Mined a log. (${i + 1}/${count})`);
        } else {
            break;
        }
    }

    const woodInInventory = bot.inventory.items().find(item => LOG_NAMES.includes(item.name));
    if (!woodInInventory || woodInInventory.count < count) {
        throw new Error(`Failed to gather enough wood. Have ${woodInInventory ? woodInInventory.count : 0}, need ${count}.`);
    }

    log("Successfully gathered wood.");
}

/**
 * Crafts all available logs into planks.
 */
async function craftPlanks() {
    const logs = bot.inventory.items().filter(item => LOG_NAMES.includes(item.name));
    if (logs.length === 0) {
        throw new Error("No logs in inventory to craft planks.");
    }

    const logCount = logs.reduce((acc, item) => acc + item.count, 0);
    log(`Found ${logCount} logs. Crafting them into planks.`);

    // For simplicity, we just craft the first type of log we find.
    const logType = logs[0].type;
    const plankName = mcData.items[logType].name.replace('_log', '_planks');
    const plankId = mcData.itemsByName[plankName].id;

    const recipe = bot.recipesFor(plankId, null, 1, null)[0];
    if (!recipe) {
        throw new Error(`No recipe found for ${plankName}.`);
    }

    await bot.craft(recipe, logCount, null);
    log(`Successfully crafted ${logCount * 4} planks.`);

    const planksInInventory = bot.inventory.findInventoryItem(plankId, null);
    if (!planksInInventory || planksInInventory.count < logCount * 4) {
        throw new Error("Crafting planks failed, not enough planks in inventory.");
    }
}

bot.on('health', () => {
    if (bot.food === 20) bot.autoEat.disable()
    else bot.autoEat.enable()
})

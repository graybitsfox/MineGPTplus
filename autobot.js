/*
* AutoBot v1.0
* Description: An autonomous mineflayer bot.
*/

// Import the required libraries
require('dotenv').config();
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoeatLoader } = require('mineflayer-auto-eat')

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
bot.loadPlugin(autoeatLoader)

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
const taskQueue = [
    'get_wood',
    'craft_planks',
    'craft_crafting_table',
    'place_crafting_table',
    'craft_sticks',
    'craft_wooden_pickaxe',
    'get_stone'
];
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
        bot.chat("Phase 1 complete. I am ready for new tasks.");
        return;
    }

    currentTask = taskQueue.shift();
    log(`Starting task: ${currentTask}`);
    busy = true;

    try {
        switch (currentTask) {
            case 'get_wood':
                await getWood(3);
                break;
            case 'craft_planks':
                await craftPlanks();
                break;
            case 'craft_crafting_table':
                await craftCraftingTable();
                break;
            case 'place_crafting_table':
                await placeCraftingTable();
                break;
            case 'craft_sticks':
                await craftSticks();
                break;
            case 'craft_wooden_pickaxe':
                await craftWoodenPickaxe();
                break;
            case 'get_stone':
                await getStone(3);
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

async function getWood(count) {
    const logIds = LOG_NAMES.map(name => mcData.blocksByName[name].id);
    const targetBlock = bot.findBlock({ matching: logIds, maxDistance: 64 });
    if (!targetBlock) throw new Error("No wood found nearby.");

    log(`Found wood at ${targetBlock.position}. Going to it.`);
    await bot.pathfinder.goto(new GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 1));

    log(`Arrived at wood. Mining ${count} logs.`);
    for (let i = 0; i < count; i++) {
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

async function craftPlanks() {
    const logs = bot.inventory.items().filter(item => LOG_NAMES.includes(item.name));
    if (logs.length === 0) throw new Error("No logs in inventory to craft planks.");

    const logCount = logs.reduce((acc, item) => acc + item.count, 0);
    log(`Found ${logCount} logs. Crafting them into planks.`);

    const logType = logs[0].type;
    const plankName = mcData.items[logType].name.replace('_log', '_planks');
    const plankId = mcData.itemsByName[plankName].id;

    const recipe = bot.recipesFor(plankId, null, 1, null)[0];
    if (!recipe) throw new Error(`No recipe found for ${plankName}.`);

    await bot.craft(recipe, logCount, null);
    log(`Successfully crafted ${logCount * 4} planks.`);

    const planksInInventory = bot.inventory.findInventoryItem(plankId, null);
    if (!planksInInventory || planksInInventory.count < logCount * 4) {
        throw new Error("Crafting planks failed, not enough planks in inventory.");
    }
}

async function craftCraftingTable() {
    const plankName = LOG_NAMES[0].replace('_log', '_planks');
    const planks = bot.inventory.findInventoryItem(mcData.itemsByName[plankName].id, null);
    if (!planks || planks.count < 4) throw new Error("Not enough planks to craft a crafting table.");

    const craftingTableId = mcData.itemsByName.crafting_table.id;
    const recipe = bot.recipesFor(craftingTableId, null, 1, null)[0];
    if (!recipe) throw new Error("No recipe for crafting table found.");

    await bot.craft(recipe, 1, null);
    log("Successfully crafted a crafting table.");

    const craftingTable = bot.inventory.findInventoryItem(craftingTableId, null);
    if (!craftingTable) throw new Error("Crafting table not found in inventory after crafting.");
}

async function placeCraftingTable() {
    const craftingTable = bot.inventory.findInventoryItem(mcData.itemsByName.crafting_table.id, null);
    if (!craftingTable) throw new Error("No crafting table in inventory to place.");

    const referenceBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    const placePosition = await bot.findPlaceablePosition(referenceBlock.position, 4);
    if (!placePosition) throw new Error("Could not find a place to put the crafting table.");

    log(`Found a spot. Placing crafting table at ${placePosition}.`);

    await bot.equip(craftingTable, 'hand');
    await bot.placeBlock(bot.blockAt(placePosition), { x: 0, y: 1, z: 0 });

    log("Successfully placed crafting table.");

    const block = bot.blockAt(placePosition.offset(0,1,0));
    if (block.name !== 'crafting_table') {
        throw new Error("Verification failed: Crafting table not found at the target position.");
    }
}

async function craftSticks() {
    const plankName = LOG_NAMES[0].replace('_log', '_planks');
    const planks = bot.inventory.findInventoryItem(mcData.itemsByName[plankName].id, null);
    if (!planks || planks.count < 2) throw new Error("Not enough planks to craft sticks.");

    const stickId = mcData.itemsByName.stick.id;
    const recipe = bot.recipesFor(stickId, null, 1, null)[0];
    if (!recipe) throw new Error("No recipe for sticks found.");

    await bot.craft(recipe, 1, null);
    log("Successfully crafted sticks.");

    const sticks = bot.inventory.findInventoryItem(stickId, null);
    if (!sticks || sticks.count < 4) throw new Error("Sticks not found in inventory after crafting.");
}

async function craftWoodenPickaxe() {
    const stick = bot.inventory.findInventoryItem(mcData.itemsByName.stick.id, null);
    if (!stick || stick.count < 2) throw new Error("Not enough sticks for a pickaxe.");

    const plankName = LOG_NAMES[0].replace('_log', '_planks');
    const planks = bot.inventory.findInventoryItem(mcData.itemsByName[plankName].id, null);
    if (!planks || planks.count < 3) throw new Error("Not enough planks for a pickaxe.");

    const craftingTable = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
    if (!craftingTable) throw new Error("No crafting table nearby.");

    const pickaxeId = mcData.itemsByName.wooden_pickaxe.id;
    const recipe = bot.recipesFor(pickaxeId, null, 1, craftingTable)[0];
    if (!recipe) throw new Error("No recipe for wooden pickaxe found.");

    await bot.craft(recipe, 1, craftingTable);
    log("Successfully crafted a wooden pickaxe.");

    const pickaxe = bot.inventory.findInventoryItem(pickaxeId, null);
    if (!pickaxe) throw new Error("Wooden pickaxe not found in inventory after crafting.");
}

async function getStone(count) {
    const pickaxe = bot.inventory.findInventoryItem(mcData.itemsByName.wooden_pickaxe.id, null);
    if (!pickaxe) throw new Error("No wooden pickaxe in inventory.");

    await bot.equip(pickaxe, 'hand');

    const stoneBlock = bot.findBlock({ matching: mcData.blocksByName.stone.id, maxDistance: 64 });
    if (!stoneBlock) throw new Error("No stone found nearby.");

    log(`Found stone at ${stoneBlock.position}. Going to it.`);
    await bot.pathfinder.goto(new GoalNear(stoneBlock.position.x, stoneBlock.position.y, stoneBlock.position.z, 1));

    log(`Arrived at stone. Mining ${count} blocks.`);
    for (let i = 0; i < count; i++) {
        const block = bot.findBlock({ matching: mcData.blocksByName.stone.id, maxDistance: 2 });
        if (block) {
            await bot.dig(block);
            log(`Mined a block of stone. (${i + 1}/${count})`);
        } else {
            log("No more stone in immediate vicinity.");
            break;
        }
    }

    const cobblestone = bot.inventory.findInventoryItem(mcData.itemsByName.cobblestone.id, null);
    if (!cobblestone || cobblestone.count < count) {
        throw new Error(`Failed to gather enough stone. Have ${cobblestone ? cobblestone.count : 0}, need ${count}.`);
    }

    log("Successfully gathered stone.");
}

bot.on('health', () => {
    if (bot.food === 20) bot.autoEat.disable()
    else bot.autoEat.enable()
})

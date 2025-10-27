const { createMCServer } = require('flying-squid')

console.log("Starting Minecraft server...");

const server = createMCServer({
  port: 25565,
  version: '1.18.2', // A version compatible with mineflayer
  'online-mode': false, // Important for local testing without authentication
  motd: 'AutoBot Test Server',
  'max-players': 10,
  logging: true,
  plugins: {} // Add this empty object to fix the error
})

server.on('listening', () => {
  console.log(`Server listening on port ${server.socketServer.address().port}!`);
});

server.on('login', (client) => {
    console.log(`${client.username} connected.`);
    client.write('chat', { message: JSON.stringify({ text: `Welcome to the server, ${client.username}!` }), position: 1, sender: '0' });
});

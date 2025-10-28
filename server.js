const { createMCServer } = require('flying-squid')

console.log("Starting Minecraft server...");

const server = createMCServer({
  port: 25565,
  version: '1.18.2',
  'online-mode': false,
  motd: 'AutoBot Test Server',
  'max-players': 10,
  logging: true,
  'view-distance': 10,
  plugins: {}
})

server.on('listening', () => {
  // This line was causing a crash, simplified it.
  console.log(`Server is listening on port 25565.`);
});

server.on('login', (client) => {
    console.log(`${client.username} connected.`);
    client.write('chat', { message: JSON.stringify({ text: `Welcome to the server, ${client.username}!` }), position: 1, sender: '0' });
});

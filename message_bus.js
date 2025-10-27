const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

console.log("Message Bus server started on port 8080.");

wss.on('connection', ws => {
  console.log('A bot has connected.');

  ws.on('message', message => {
    // When a message is received, broadcast it to all other connected bots.
    console.log('Received message:', message.toString());
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => {
    console.log('A bot has disconnected.');
  });
});

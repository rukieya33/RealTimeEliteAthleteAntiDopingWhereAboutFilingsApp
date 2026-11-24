'use strict';

/**
 * Server-Sent Events hub. Every connected browser keeps one EventSource open
 * to /api/stream; any change to whereabouts data is pushed to all of them
 * immediately, and a periodic "tick" keeps live slot states current.
 */
const clients = new Set();
let eventId = 0;

function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, user: req.user };
  clients.add(client);
  send(client, 'hello', { connectedClients: clients.size, serverTime: new Date().toISOString() });

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(client);
    broadcast('presence', { connectedClients: clients.size });
  });
  broadcast('presence', { connectedClients: clients.size });
}

function send(client, type, data) {
  eventId += 1;
  client.res.write(`id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(type, data = {}) {
  for (const client of clients) {
    try {
      send(client, type, { ...data, at: new Date().toISOString() });
    } catch {
      clients.delete(client);
    }
  }
}

function clientCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, clientCount };

#!/usr/bin/env node
'use strict';
// Minimal JSON-RPC serve-like server for client unit tests.
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id == null) return;

  switch (msg.method) {
    case 'serve.ping':
      send({ jsonrpc: '2.0', id: msg.id, result: { ok: true, pid: process.pid, version: '1.5.2', node: process.version } });
      break;
    case 'echo':
      send({ jsonrpc: '2.0', id: msg.id, result: msg.params });
      break;
    case 'fail':
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'boom' } });
      break;
    case 'notify.test':
      send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
      setTimeout(() => send({ jsonrpc: '2.0', method: 'test.event', params: { value: msg.params?.value } }), 20);
      break;
    case 'slow':
      // never answers — used for timeout tests
      break;
    case 'crash':
      process.exit(1);
      break;
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});

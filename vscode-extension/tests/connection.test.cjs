const assert = require('node:assert/strict');
const { once } = require('node:events');
const Module = require('node:module');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        workspaceFolders: [{
          name: 'test-workspace',
          uri: { toString: () => 'file:///test-workspace' },
        }],
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { GorConnection } = require('../out/connection.js');
Module._load = originalLoad;

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for connection state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('connects, registers workspace, detects disconnect, and reconnects', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  let connectionNumber = 0;
  const workspaceResponses = [];
  const treeChanges = [];
  server.on('connection', (socket) => {
    connectionNumber += 1;
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'workspace_response') {
        workspaceResponses.push(message);
        return;
      }
      if (message.type === 'workspace_tree_changed') {
        treeChanges.push(message);
        return;
      }
      assert.equal(message.type, 'workspace_connected');
      assert.equal(message.client, 'vscode');
      assert.equal(message.workspaceName, 'test-workspace');
      assert.deepEqual(message.workspaceFolders, [{
        id: 'root-1',
        name: 'test-workspace',
        uri: 'file:///test-workspace',
      }]);
      socket.send(JSON.stringify({
        type: 'workspace_registered',
        workspaceId: `vscode-test${connectionNumber}`,
      }));
    });
  });

  const logs = [];
  const states = [];
  const output = { appendLine: (line) => logs.push(line) };
  const connection = new GorConnection(
    `ws://127.0.0.1:${server.address().port}`,
    output,
    (status, workspaceId) => states.push({ status, workspaceId }),
    (request, workspaceId, send) => {
      assert.equal(request.method, 'project.listFiles');
      assert.equal(workspaceId, 'vscode-test1');
      send({
        type: 'workspace_response',
        requestId: request.requestId,
        workspaceId,
        success: true,
        result: { files: ['/src/App.tsx'] },
      });
    },
  );

  try {
    await connection.connect();
    await waitFor(() => connection.workspaceId === 'vscode-test1');
    assert.equal(connection.currentStatus, 'connected');

    const firstClient = [...server.clients][0];
    firstClient.send(JSON.stringify({
      type: 'workspace_request',
      requestId: 'req-test',
      workspaceId: 'vscode-test1',
      method: 'project.listFiles',
      params: {},
    }));
    await waitFor(() => workspaceResponses.length === 1);
    assert.deepEqual(workspaceResponses[0].result, { files: ['/src/App.tsx'] });

    connection.notifyWorkspaceTreeChanged('root-1');
    await waitFor(() => treeChanges.length === 1);
    assert.deepEqual(treeChanges[0], { type: 'workspace_tree_changed', root: 'root-1' });

    for (const client of server.clients) client.close();
    await waitFor(() => connection.currentStatus === 'disconnected');

    await waitFor(() => connection.workspaceId === 'vscode-test2', 3000);
    assert.equal(connection.currentStatus, 'connected');
    assert(states.some((state) => state.status === 'disconnected'));
    assert(logs.includes('[Gor] Disconnected'));
    assert(logs.includes('[Gor] Workspace registered: vscode-test2'));
  } finally {
    connection.dispose();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

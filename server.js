#!/usr/bin/env node
/**
 * netbench —— 单端口网络测速服务
 *
 * 监听 8080，在一个端口上同时提供：
 *   1. HTML 测速页面（public/index.html）
 *   2. PeerJS 信令服务器（挂载于 /peerjs，供 PeerJS 客户端连接与测速）
 *   3. 内置 PeerJS WebRTC 服务端节点（ID: server，供浏览器客户端直连本服务器测速）
 *   4. HTTP 测试端点：/api/ping（延迟）、/api/blob?size=N（下行吞吐）、/api/upload（上行吞吐）
 *   5. WebSocket 回声与吞吐端点：/ws
 *
 * 用法：
 *   node server.js                 # 默认 0.0.0.0:8080
 *   PORT=9090 node server.js       # 换端口
 *   DEBUG=1 node server.js         # peerjs 调试日志
 */
const http = require('http');
const path = require('path');
const express = require('express');
const { ExpressPeerServer } = require('peer');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DEBUG = !!process.env.DEBUG;
const SERVER_PEER_ID = process.env.SERVER_PEER_ID || 'server';

// Polyfill WebRTC and WebSocket for server-side PeerJS WebRTC peer
try {
  const nodeDataChannel = require('node-datachannel');
  // 核心解除 SCTP 拥塞瓶颈：将底层收发缓冲区由默认几百 KB 扩大至 64 MB
  if (typeof nodeDataChannel.setSctpSettings === 'function') {
    nodeDataChannel.setSctpSettings({
      sendBufferSize: 64 * 1024 * 1024, // 64 MB 发送缓冲
      recvBufferSize: 64 * 1024 * 1024, // 64 MB 接收缓冲
      maxChunksOnQueue: 262144,
      initialCongestionWindow: 256,
      maxBurst: 64,
    });
    console.log('[server-peer] SCTP 64MB buffers & high-speed congestion window applied [OK]');
  }

  const poly = require('node-datachannel/polyfill');
  Object.assign(global, poly);
  global.WebSocket = WebSocket;
  global.location = { protocol: 'http:', hostname: '127.0.0.1', port: String(PORT) };
} catch (e) {
  console.warn('[server-peer] Failed to initialize node-datachannel polyfill:', e.message);
}
const { Peer } = require('peerjs');

const app = express();
const server = http.createServer(app);
app.set('trust proxy', true);

/* ------------------------------------------------------------------ */
/* WebSocket 路由：用 noServer 的 WSS + 手动 upgrade 分发，避免 ws v8     */
/* 在共享 server 上每个 WSS 都拦截并 400 非本路径请求的问题。            */
/* ------------------------------------------------------------------ */
const peerWSS = { current: null };

/* ------------------------------------------------------------------ */
/* PeerJS 信令服务器（与页面共用同一端口，挂载在 /peerjs）              */
/*                                                                     */
/* 挂载路径 /peerjs + path:'/'  ⇒  客户端用 { host, port, path:'/peerjs' }   */
/* 信令 WebSocket 端点： ws://host:port/peerjs/peerjs                    */
/* HTTP 信息端点：     http://host:port/peerjs/                         */
/* 随机 ID 端点：      http://host:port/peerjs/peerjs/id                */
/* 在线列表端点：      http://host:port/peerjs/peerjs/peers (allow_discovery) */
/* ------------------------------------------------------------------ */
const peerServer = ExpressPeerServer(server, {
  path: '/',
  key: 'peerjs',
  allow_discovery: true,
  alive_timeout: 90000,
  expire_timeout: 10000,
  proxied: true,
  debug: DEBUG ? 1 : 0,
  // 让 peerjs 内部 WSS 不直接绑定 server，改由下方手动 upgrade 路由接管
  createWebSocketServer: (opts) => {
    const wss = new WebSocketServer({ noServer: true, path: opts.path });
    peerWSS.current = wss;
    return wss;
  },
});
app.use('/peerjs', peerServer);
peerServer.on('connection', (client) => {
  if (DEBUG || client.getId() !== SERVER_PEER_ID) {
    console.log(`[peer] + ${client.getId()}`);
  }
});
peerServer.on('disconnect', (client) => {
  if (DEBUG || client.getId() !== SERVER_PEER_ID) {
    console.log(`[peer] - ${client.getId()}`);
  }
});
peerServer.on('error', (err) => console.error('[peer] error:', err));

/* ------------------------------------------------------------------ */
/* 静态页面与本地托管的 peerjs 客户端库（离线可用）                      */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public')));

app.get('/vendor/peerjs.min.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(__dirname, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js'));
});

/* ------------------------------------------------------------------ */
/* HTTP 测试端点                                                       */
/* ------------------------------------------------------------------ */
// 延迟探测：返回当前服务器时间
app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, t: Date.now(), server: 'netbench' });
});

// 下行吞吐：返回 size 字节（默认 1MB，上限 512MB），流式发送不占内存
app.get('/api/blob', (req, res) => {
  const size = Math.max(0, Math.min(parseInt(req.query.size || '1048576', 10) || 1048576, 512 * 1024 * 1024));
  const CHUNK = 64 * 1024;
  const chunk = Buffer.alloc(CHUNK, 0x5a);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(size));
  res.set('Cache-Control', 'no-store');
  res.set('X-Netbench-Size', String(size));
  let sent = 0;
  const pump = () => {
    while (sent < size) {
      const n = Math.min(CHUNK, size - sent);
      sent += n;
      const ok = res.write(n === CHUNK ? chunk : chunk.subarray(0, n));
      if (!ok) { res.once('drain', pump); return; }
    }
    res.end();
  };
  pump();
});

// 上行吞吐：接受 POST 请求体并计数（上限 512MB），返回收到的字节数
app.post('/api/upload', (req, res) => {
  const MAX = 512 * 1024 * 1024;
  let size = 0, done = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX && !done) {
      done = true;
      res.status(413).json({ ok: false, error: 'too large', max: MAX });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!done) { done = true; res.json({ ok: true, size, t: Date.now(), server: 'netbench' }); }
  });
  req.on('error', () => {
    if (!done) { done = true; res.status(500).json({ ok: false, error: 'stream error' }); }
  });
});

// 服务信息
app.get('/api/info', (req, res) => {
  res.json({
    ok: true,
    server: 'netbench',
    port: PORT,
    peerPath: '/peerjs',
    serverPeerId: SERVER_PEER_ID,
    wsPath: '/ws',
    uploadPath: '/api/upload',
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket 端点（/ws）                                                */
/* 默认行为 = 回声（保留「测速(回显)」与 ping）；扩展协议：              */
/*   {m:'down',size,id}   → 服务端推送 size 字节二进制（下行测速）       */
/*   {m:'upStart',size,id} → 进入上行计数；收满 size 字节回 {m:'upDone'} */
/* 其余（含 {m:'ping'}、二进制）仍原样回声。                            */
/* ------------------------------------------------------------------ */
const echoWSS = new WebSocketServer({ noServer: true, path: '/ws' });
const WSS_CHUNK = 64 * 1024;
const WSS_MAX = 512 * 1024 * 1024;
echoWSS.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', t: Date.now() }));
  let upMode = null; // { id, size, got }

  const sendBytes = (size, id) => {
    size = Math.max(0, Math.min(size || 0, WSS_MAX));
    const chunk = Buffer.alloc(WSS_CHUNK, 0x5a);
    let sent = 0;
    const pump = () => {
      while (sent < size) {
        const n = Math.min(WSS_CHUNK, size - sent);
        sent += n;
        ws.send(n === WSS_CHUNK ? chunk : chunk.subarray(0, n), { binary: true });
        if (ws.bufferedAmount > 8 * 1024 * 1024) { setTimeout(pump, 10); return; }
      }
    };
    pump();
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // JSON 控制消息
      try {
        const m = JSON.parse(data.toString());
        if (m && m.m === 'down') { sendBytes(m.size, m.id); return; }
        if (m && m.m === 'upStart') { upMode = { id: m.id, size: m.size || 0, got: 0 }; return; }
      } catch (e) { /* 非 JSON 文本，按回声处理 */ }
      ws.send(data, { binary: false });
      return;
    }
    // 二进制
    if (upMode) {
      upMode.got += data.length;
      if (upMode.got >= upMode.size) {
        const { id, got } = upMode;
        upMode = null;
        ws.send(JSON.stringify({ m: 'upDone', size: got, id }));
      }
      return;
    }
    ws.send(data, { binary: true }); // 回声
  });
});

// 手动 upgrade 路由：按路径分发到对应 WSS，避免多个 WSS 在共享 server 上互踩
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://netbench').pathname; } catch (e) { socket.destroy(); return; }
  if (pathname === '/ws') {
    echoWSS.handleUpgrade(req, socket, head, (ws) => echoWSS.emit('connection', ws, req));
  } else if (peerWSS.current && pathname === peerWSS.current.options.path) {
    peerWSS.current.handleUpgrade(req, socket, head, (ws) => peerWSS.current.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

/* ------------------------------------------------------------------ */
/* 内置 Server Peer（浏览器 ↔ 8080 服务端 WebRTC 直连测速节点）            */
/* ------------------------------------------------------------------ */
function initServerPeer() {
  if (process.env.DISABLE_SERVER_PEER) {
    console.log('[server-peer] Server peer disabled by DISABLE_SERVER_PEER');
    return;
  }

  let srvPeer = null;
  const CHUNK = 16 * 1024;
  const chunkBuf = Buffer.alloc(CHUNK, 0x5a);

  function start() {
    try {
      srvPeer = new Peer(SERVER_PEER_ID, {
        host: '127.0.0.1',
        port: PORT,
        path: '/peerjs',
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
          ],
        },
        debug: DEBUG ? 2 : 0,
      });

      srvPeer.on('open', (id) => {
        console.log(`[server-peer] WebRTC server peer ready! ID: "${id}" (Browser can test speed directly with 8080 server)`);
      });

      srvPeer.on('connection', (c) => {
        console.log(`[server-peer] + browser client connected: ${c.peer}`);
        let upSession = null;

        c.on('data', (data) => {
          if (typeof data === 'string') {
            let m;
            try { m = JSON.parse(data); } catch (e) { return; }
            if (m && m.m === 'ping') {
              c.send(JSON.stringify({ m: 'pong', id: m.id }));
            } else if (m && m.m === 'req') {
              console.log(`[server-peer] start downlink test for ${c.peer}, size=${m.size}`);
              let offset = 0;
              const pump = () => {
                if (!c.open) return;
                let inBatch = 0;
                while (offset < m.size && inBatch < 1024 * 1024) {
                  const n = Math.min(CHUNK, m.size - offset);
                  c.send(n === CHUNK ? chunkBuf : chunkBuf.subarray(0, n));
                  offset += n;
                  inBatch += n;
                }
                if (offset < m.size) {
                  setImmediate ? setImmediate(pump) : setTimeout(pump, 0);
                } else {
                  console.log(`[server-peer] downlink stream complete for ${c.peer}, size=${m.size}`);
                  c.send(JSON.stringify({ m: 'got', size: m.size, id: m.id }));
                }
              };
              pump();
            } else if (m && m.m === 'send') {
              console.log(`[server-peer] start uplink test for ${c.peer}, size=${m.size}`);
              upSession = { size: m.size, id: m.id, got: 0 };
            }
          } else {
            const bytes = data.byteLength !== undefined ? data.byteLength : (data.length || 0);
            if (upSession) {
              upSession.got += bytes;
              if (upSession.got >= upSession.size) {
                console.log(`[server-peer] uplink stream complete for ${c.peer}, got=${upSession.got}`);
                c.send(JSON.stringify({ m: 'got', size: upSession.size, id: upSession.id }));
                upSession = null;
              }
            }
          }
        });

        c.on('close', () => {
          console.log(`[server-peer] - browser client disconnected: ${c.peer}`);
          upSession = null;
        });

        c.on('error', (err) => {
          console.warn(`[server-peer] connection ${c.peer} warning:`, err.message || err);
        });
      });

      srvPeer.on('disconnected', () => {
        console.warn('[server-peer] disconnected from signaling, reconnecting in 2s...');
        setTimeout(() => {
          try { srvPeer.reconnect(); } catch (e) {}
        }, 2000);
      });

      srvPeer.on('error', (err) => {
        if (err && err.type === 'unavailable-id') {
          console.warn(`[server-peer] ID "${SERVER_PEER_ID}" already in use. Retrying in 2s...`);
          setTimeout(start, 2000);
        } else {
          console.error('[server-peer] error:', err.type || err.message || err);
        }
      });
    } catch (e) {
      console.error('[server-peer] failed to start peer:', e);
    }
  }

  start();
}

/* ------------------------------------------------------------------ */
server.listen(PORT, HOST, () => {
  console.log(`[netbench] listening  http://${HOST}:${PORT}/`);
  console.log(`[netbench] peerjs      ws://<host>:${PORT}/peerjs/peerjs   (client path: /peerjs)`);
  console.log(`[netbench] server peer ID: "${SERVER_PEER_ID}" (Browser ↔ Server WebRTC DataChannel speed test)`);
  console.log(`[netbench] ws echo     ws://<host>:${PORT}/ws`);
  console.log(`[netbench] api         /api/ping  /api/blob?size=1048576  POST /api/upload  /api/info`);

  initServerPeer();
});

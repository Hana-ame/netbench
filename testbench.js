#!/usr/bin/env node
/**
 * netbench CLI testbench runner
 * Automated benchmark suite for netbench HTTP, WebSocket, and PeerJS WebRTC endpoints.
 */

const http = require('http');
const { WebSocket } = require('ws');

const TARGET = process.env.TARGET || 'http://127.0.0.1:8080';
const url = new URL(TARGET);
const HOST = url.hostname;
const PORT = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
const WS_URL = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${HOST}:${PORT}/ws`;

// Polyfill WebRTC and WebSocket for PeerJS client testing
try {
  const poly = require('node-datachannel/polyfill');
  Object.assign(global, poly);
  global.WebSocket = WebSocket;
  global.location = { protocol: url.protocol, hostname: HOST, port: String(PORT) };
} catch (e) {
  console.warn('Polyfill warning:', e.message);
}
const { Peer } = require('peerjs');

const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(2) + ' ms');
const fmtSpeed = (bytes, ms) => {
  const mbps = (bytes * 8) / (ms / 1000) / 1e6;
  const mbPerSec = bytes / (ms / 1000) / (1024 * 1024);
  return `${mbps.toFixed(2)} Mbps (${mbPerSec.toFixed(2)} MB/s)`;
};

function hrtimeToMs(diff) {
  return diff[0] * 1000 + diff[1] / 1e6;
}

// HTTP request helper
function httpRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime();
    let ttfb = null;
    let bytes = 0;

    const req = http.request(options, (res) => {
      res.once('data', () => {
        ttfb = hrtimeToMs(process.hrtime(start));
      });

      res.on('data', (chunk) => {
        bytes += chunk.length;
      });

      res.on('end', () => {
        const totalTime = hrtimeToMs(process.hrtime(start));
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          bytes,
          ttfb: ttfb || totalTime,
          totalTime,
        });
      });
    });

    req.on('error', reject);

    if (data) {
      if (Buffer.isBuffer(data)) {
        req.write(data);
      } else if (typeof data.pipe === 'function') {
        data.pipe(req);
        return;
      } else {
        req.write(data);
      }
    }
    req.end();
  });
}

// 1. HTTP Latency Ping
async function benchmarkHttpPing(rounds = 10) {
  process.stdout.write(`\n[1/7] Running HTTP Ping benchmark (${rounds} rounds)... `);
  const times = [];

  for (let i = 0; i < rounds; i++) {
    const res = await httpRequest({
      hostname: HOST,
      port: PORT,
      path: '/api/ping',
      method: 'GET',
    });
    if (res.statusCode === 200) {
      times.push(res.totalTime);
    }
  }

  times.sort((a, b) => a - b);
  const min = times[0];
  const max = times[times.length - 1];
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const median = times[Math.floor(times.length / 2)];

  console.log('DONE');
  console.log(`      min: ${fmtMs(min)} | avg: ${fmtMs(avg)} | median: ${fmtMs(median)} | max: ${fmtMs(max)}`);
  return { min, avg, median, max };
}

// 2. HTTP Downlink
async function benchmarkHttpDownload(sizes = [1 * 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
  console.log('\n[2/7] Running HTTP Downlink (GET /api/blob)...');
  for (const size of sizes) {
    const label = `${size / (1024 * 1024)} MB`;
    const res = await httpRequest({
      hostname: HOST,
      port: PORT,
      path: `/api/blob?size=${size}`,
      method: 'GET',
    });

    const speedStr = fmtSpeed(res.bytes, res.totalTime);
    console.log(`      Size: ${label.padEnd(6)} | TTFB: ${fmtMs(res.ttfb).padEnd(9)} | Time: ${fmtMs(res.totalTime).padEnd(9)} | Speed: ${speedStr}`);
  }
}

// 3. HTTP Uplink
async function benchmarkHttpUpload(sizes = [1 * 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024]) {
  console.log('\n[3/7] Running HTTP Uplink (POST /api/upload)...');
  for (const size of sizes) {
    const label = `${size / (1024 * 1024)} MB`;
    const payload = Buffer.alloc(size, 0x5a);

    const res = await httpRequest(
      {
        hostname: HOST,
        port: PORT,
        path: '/api/upload',
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
        },
      },
      payload
    );

    const speedStr = fmtSpeed(size, res.totalTime);
    console.log(`      Size: ${label.padEnd(6)} | Time: ${fmtMs(res.totalTime).padEnd(9)} | Speed: ${speedStr}`);
  }
}

// 4. WebSocket Benchmarks
function runWsSuite() {
  return new Promise((resolve, reject) => {
    console.log('\n[4/7] Connecting to WebSocket (/ws)...');
    const startConn = process.hrtime();
    const ws = new WebSocket(WS_URL);

    ws.on('open', async () => {
      const connTime = hrtimeToMs(process.hrtime(startConn));
      console.log(`      Connected in ${fmtMs(connTime)}`);

      try {
        // WS Ping
        process.stdout.write('\n[5/7] Running WebSocket Ping-Pong (10 rounds)... ');
        const pingTimes = [];
        for (let i = 0; i < 10; i++) {
          const t0 = process.hrtime();
          await new Promise((res) => {
            const onMsg = (data) => {
              try {
                const parsed = JSON.parse(data.toString());
                if (parsed.m === 'ping') {
                  ws.removeListener('message', onMsg);
                  res();
                }
              } catch (_) {}
            };
            ws.on('message', onMsg);
            ws.send(JSON.stringify({ m: 'ping', t: Date.now() }));
          });
          pingTimes.push(hrtimeToMs(process.hrtime(t0)));
        }
        pingTimes.sort((a, b) => a - b);
        console.log('DONE');
        console.log(`      min: ${fmtMs(pingTimes[0])} | avg: ${fmtMs(pingTimes.reduce((a, b) => a + b, 0) / pingTimes.length)} | max: ${fmtMs(pingTimes[pingTimes.length - 1])}`);

        // WS Downlink & Uplink
        console.log('\n[6/7] Running WebSocket Throughput...');
        const testSizes = [1 * 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

        for (const size of testSizes) {
          const label = `${size / (1024 * 1024)} MB`;
          let received = 0;
          const t0 = process.hrtime();

          await new Promise((res) => {
            const onChunk = (data, isBinary) => {
              if (isBinary) {
                received += data.length;
                if (received >= size) {
                  ws.removeListener('message', onChunk);
                  res();
                }
              }
            };
            ws.on('message', onChunk);
            ws.send(JSON.stringify({ m: 'down', size, id: 'test' }));
          });

          const dur = hrtimeToMs(process.hrtime(t0));
          console.log(`      WS Down [${label.padEnd(5)}]: Time: ${fmtMs(dur).padEnd(9)} | Speed: ${fmtSpeed(size, dur)}`);
        }

        const CHUNK = 64 * 1024;
        const chunkBuf = Buffer.alloc(CHUNK, 0x5a);

        for (const size of testSizes) {
          const label = `${size / (1024 * 1024)} MB`;
          const t0 = process.hrtime();

          await new Promise((res) => {
            const onMsg = (data, isBinary) => {
              if (!isBinary) {
                try {
                  const m = JSON.parse(data.toString());
                  if (m.m === 'upDone') {
                    ws.removeListener('message', onMsg);
                    res();
                  }
                } catch (_) {}
              }
            };
            ws.on('message', onMsg);
            ws.send(JSON.stringify({ m: 'upStart', size, id: 'test' }));

            let sent = 0;
            const pump = () => {
              while (sent < size) {
                const n = Math.min(CHUNK, size - sent);
                sent += n;
                ws.send(n === CHUNK ? chunkBuf : chunkBuf.subarray(0, n), { binary: true });
                if (ws.bufferedAmount > 4 * 1024 * 1024) {
                  setTimeout(pump, 5);
                  return;
                }
              }
            };
            pump();
          });

          const dur = hrtimeToMs(process.hrtime(t0));
          console.log(`      WS Up   [${label.padEnd(5)}]: Time: ${fmtMs(dur).padEnd(9)} | Speed: ${fmtSpeed(size, dur)}`);
        }

        ws.close();
        resolve();
      } catch (err) {
        ws.close();
        reject(err);
      }
    });

    ws.on('error', reject);
  });
}

// 5. PeerJS WebRTC DataChannel (Client ↔ Server Peer)
async function benchmarkPeerJsWebRtc() {
  console.log('\n[7/7] Running PeerJS WebRTC DataChannel benchmark (Client ↔ Server Peer)...');
  return new Promise((resolve, reject) => {
    const cli = new Peer({
      host: HOST,
      port: PORT,
      path: '/peerjs',
      config: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      },
      debug: 0,
    });

    const timeout = setTimeout(() => {
      cli.destroy();
      reject(new Error('PeerJS WebRTC test timed out'));
    }, 25000);

    cli.on('open', (id) => {
      console.log(`      Client peer initialized (${id}) -> connecting to "server"...`);
      const conn = cli.connect('server', { serialization: 'raw', reliable: true });

      conn.on('open', async () => {
        console.log('      WebRTC DataChannel connected successfully!');

        try {
          // WebRTC Ping
          const pings = [];
          for (let i = 0; i < 5; i++) {
            const t0 = process.hrtime();
            const pingId = `p_${i}_${Date.now()}`;
            await new Promise((res) => {
              const onData = (data) => {
                if (typeof data === 'string') {
                  try {
                    const m = JSON.parse(data);
                    if (m.m === 'pong' && m.id === pingId) {
                      conn.off('data', onData);
                      res();
                    }
                  } catch (_) {}
                }
              };
              conn.on('data', onData);
              conn.send(JSON.stringify({ m: 'ping', id: pingId }));
            });
            pings.push(hrtimeToMs(process.hrtime(t0)));
          }
          pings.sort((a, b) => a - b);
          console.log(`      WebRTC Ping (5 rounds): min: ${fmtMs(pings[0])} | avg: ${fmtMs(pings.reduce((a, b) => a + b, 0) / pings.length)} | max: ${fmtMs(pings[pings.length - 1])}`);

          // WebRTC Download
          for (const size of [1 * 1024 * 1024, 4 * 1024 * 1024]) {
            const label = `${size / (1024 * 1024)} MB`;
            let received = 0;
            const t0 = process.hrtime();
            const reqId = `req_${size}_${Date.now()}`;

            await new Promise((res) => {
              const onChunk = (data) => {
                if (typeof data !== 'string') {
                  const bytes = data.byteLength !== undefined ? data.byteLength : (data.length || 0);
                  received += bytes;
                } else {
                  try {
                    const m = JSON.parse(data);
                    if (m.m === 'got' && m.size === size) {
                      conn.off('data', onChunk);
                      res();
                    }
                  } catch (_) {}
                }
              };
              conn.on('data', onChunk);
              conn.send(JSON.stringify({ m: 'req', size, id: reqId }));
            });

            const dur = hrtimeToMs(process.hrtime(t0));
            console.log(`      WebRTC Down [${label.padEnd(5)}]: Time: ${fmtMs(dur).padEnd(9)} | Speed: ${fmtSpeed(size, dur)}`);
          }

          // WebRTC Upload
          const CHUNK = 64 * 1024;
          const chunkBuf = Buffer.alloc(CHUNK, 0x5a);

          for (const size of [1 * 1024 * 1024, 4 * 1024 * 1024]) {
            const label = `${size / (1024 * 1024)} MB`;
            const t0 = process.hrtime();
            const upId = `up_${size}_${Date.now()}`;

            await new Promise((res) => {
              const onGot = (data) => {
                if (typeof data === 'string') {
                  try {
                    const m = JSON.parse(data);
                    if (m.m === 'got' && m.size === size) {
                      conn.off('data', onGot);
                      res();
                    }
                  } catch (_) {}
                }
              };
              conn.on('data', onGot);
              conn.send(JSON.stringify({ m: 'send', size, id: upId }));

              let sent = 0;
              const pump = () => {
                while (sent < size) {
                  const n = Math.min(CHUNK, size - sent);
                  conn.send(n === CHUNK ? chunkBuf : chunkBuf.subarray(0, n));
                  sent += n;
                  if (conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) {
                    setTimeout(pump, 5);
                    return;
                  }
                }
              };
              pump();
            });

            const dur = hrtimeToMs(process.hrtime(t0));
            console.log(`      WebRTC Up   [${label.padEnd(5)}]: Time: ${fmtMs(dur).padEnd(9)} | Speed: ${fmtSpeed(size, dur)}`);
          }

          clearTimeout(timeout);
          conn.close();
          cli.destroy();
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          conn.close();
          cli.destroy();
          reject(err);
        }
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        cli.destroy();
        reject(err);
      });
    });

    cli.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// 6. PeerJS signaling check
async function checkPeerJsSignaling() {
  console.log('\n[+] Verifying PeerJS signaling & discovery endpoints...');
  const idRes = await httpRequest({
    hostname: HOST,
    port: PORT,
    path: '/peerjs/peerjs/id',
    method: 'GET',
  });
  const peersRes = await httpRequest({
    hostname: HOST,
    port: PORT,
    path: '/peerjs/peerjs/peers',
    method: 'GET',
  });

  if (idRes.statusCode === 200 && peersRes.statusCode === 200) {
    console.log('      PeerJS ID & Discovery APIs are operational [OK]');
  } else {
    console.warn(`      PeerJS signaling returned non-200 status (id=${idRes.statusCode}, peers=${peersRes.statusCode})`);
  }
}

async function main() {
  console.log('========================================================');
  console.log(`  netbench Testbench Benchmark Suite`);
  console.log(`  Target: ${TARGET}`);
  console.log(`  Time  : ${new Date().toISOString()}`);
  console.log('========================================================');

  try {
    await checkPeerJsSignaling();
    await benchmarkHttpPing();
    await benchmarkHttpDownload();
    await benchmarkHttpUpload();
    await runWsSuite();
    await benchmarkPeerJsWebRtc();

    console.log('\n========================================================');
    console.log('  ALL TESTBENCH SUITES COMPLETED SUCCESSFULLY!');
    console.log('========================================================\n');
  } catch (err) {
    console.error('\nTestbench failed:', err);
    process.exit(1);
  }
}

main();

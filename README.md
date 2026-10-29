# netbench —— 单端口全栈网络测速工具

[![CI/CD Pipeline](https://github.com/Hana-ame/netbench/actions/workflows/ci.yml/badge.svg)](https://github.com/Hana-ame/netbench/actions/workflows/ci.yml)
[![Docker Image](https://img.shields.io/badge/docker-ghcr.io-blue.svg)](https://github.com/Hana-ame/netbench/pkgs/container/netbench)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-green.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

监听 **8080** 单端口，同时提供现代化全功能测速 Web UI、内置 Node.js WebRTC 测速端点、PeerJS 信令服务、HTTP 延迟与上下行端点以及 WebSocket 双向测速服务。

---

## ⚡ 特性亮点

- **全协议三分类架构**：现代化深色仪表盘，清晰分为 **🌐 HTTP**、**⚡ WebSocket**、**🔗 WebRTC (PeerJS)** 三大核心板块。
- **极简单一服务器 URL**：告别繁琐的主机、端口、HTTPS 下拉框；只需输入一个基础 URL（例如 `https://example.com`），自动解析派生所有 HTTP、WS (`ws://` / `wss://`) 和 WebRTC 信令端点。
- **真正服务端直连 WebRTC 测速**：服务端基于 `node-datachannel` 运行内置 Peer 节点（ID: `server`），浏览器直接与 8080 服务器测速，无需打开两个网页建立 P2P。
- **高延迟/公网优化流控**：
  - 16 KB MTU 安全分块 + SCTP 发送缓冲区（`bufferedAmount`）背压控制，彻底杜绝跨公网时 WebRTC 数据通道消息溢出及丢包死锁。
  - 测速互斥锁保护，防止并发测试拥塞链路。
  - 动态传输超时与实时百分比传输进度（`0%` → `99%` → `Mbps`）。
- **自动化测试套件 (Testbench)**：提供包含 7 大测试项的 CLI 自动化基准测试工具，开箱支持 CI/CD 流水线。

---

## 快速开始

### 方式 1：Node.js 本地运行

```bash
git clone git@github.com:Hana-ame/netbench.git
cd netbench
npm install
npm start
# 浏览器访问 http://localhost:8080/
```

- 环境变量配置：
  - `PORT=8080`：修改监听端口（默认 8080）。
  - `HOST=0.0.0.0`：绑定网络地址。
  - `DEBUG=1`：开启详细 PeerJS 与 WebRTC 调试日志。

### 方式 2：Docker 运行

```bash
docker run -d --name netbench -p 8080:8080 ghcr.io/hana-ame/netbench:latest
```

或使用本地构建：
```bash
docker build -t netbench .
docker run -d -p 8080:8080 netbench
```

---

## 自动化测试 (Testbench)

项目内置了针对全协议端点的基准测试套件：

```bash
npm test
# 或者指定目标环境
TARGET=http://127.0.0.1:8080 npm run testbench
```

测试套件会自动覆盖：
1. `PeerJS` 信令 API 连通性与节点发现（`/peerjs/peerjs/peers`）
2. `HTTP Ping` 延迟（10 轮统计 min/avg/median/max）
3. `HTTP Downlink` GET 流式吞吐（1 MB、4 MB、16 MB）
4. `HTTP Uplink` POST 上传吞吐（1 MB、4 MB、16 MB）
5. `WebSocket Ping` 往返时延（RTT）
6. `WebSocket` 下行与分块上行吞吐测试
7. `PeerJS WebRTC DataChannel` 握手、直连 Ping、4MB 下行与上行全链路压测

---

## 内置 API 端点

| 端点 | 协议 | 功能说明 |
|---|---|---|
| `/api/ping` | HTTP GET | 毫秒级延迟探测 |
| `/api/blob?size={bytes}` | HTTP GET | 服务端流式生成二进制下行数据（支持至 512 MB） |
| `/api/upload` | HTTP POST | 二进制流式上传接收与统计 |
| `/api/info` | HTTP GET | 服务状态、端口与内置 Peer ID 查询 |
| `/ws` | WebSocket | 双向 Ping-Pong、下行推流 (`down`)、上行计数 (`upStart`/`upDone`) |
| `/peerjs/*` | HTTP / WS | PeerJS 信令协商与对端发现 |

---

## 项目结构

```
netbench/
├── .github/workflows/
│   └── ci.yml          # GitHub Actions 自动化测试与 Docker 构建发布
├── public/
│   ├── index.html      # 三分类现代化深色测速前端 UI
│   └── vendor/         # 本地离线版 peerjs.min.js
├── Dockerfile          # 生产轻量容器镜像定义
├── server.js           # Express + PeerServer + WebSocket + 内置 Node WebRTC Peer
├── testbench.js        # CLI 自动化全景性能测试套件
└── package.json
```

## 协议

[MIT License](LICENSE)

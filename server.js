const http = require('http');
const https = require('https'); // Back4app 自动 TLS
const WebSocket = require('ws');
const crypto = require('crypto');
const net = require('net');
const url = require('url');
const { createProxyServer } = require('http-proxy');

// 配置（用环境变量覆盖）
const UUID = process.env.UUID || 'de04add9-5c68-8bab-950c-08cd5320df18'; // 替换您的 UUID
const PORT = process.env.PORT || 3000;
const VLESS_PATH = process.env.VLESS_PATH || '/vl';

// VLESS 协议常量
const VLESS_VERSION = 0;
const CMD_TCP = 1;
const CMD_UDP = 2;
const ATYP_IP = 1;
const ATYP_DOMAIN = 3;

// 伪装页面
const FAKE_PAGE = `
<!DOCTYPE html>
<html lang="en">
<head><title>VLESS Proxy</title></head>
<body><h1>Welcome to VLESS Node.js Proxy</h1><p>This is a fake page for camouflage.</p></body>
</html>
`;

// UUID 验证函数
function validateUUID(clientUUID) {
  return crypto.createHash('md5').update(clientUUID).digest('hex') === crypto.createHash('md5').update(UUID).digest('hex');
}

// VLESS 握手解析
function parseVLESSHeader(buffer) {
  if (buffer.length < 2) return null;
  const version = buffer[0];
  if (version !== VLESS_VERSION) return null;
  const uuid = buffer.slice(1, 17).toString('hex'); // UUID 16 bytes
  if (!validateUUID(uuid)) return null;
  const addLen = buffer.length - 18;
  if (addLen < 6) return null;
  const cmd = buffer[17];
  const port = buffer.readUInt16BE(18);
  const addrType = buffer[20];
  let addr, addrLen;
  if (addrType === ATYP_IP) {
    addr = buffer.slice(21, 25).join('.');
    addrLen = 4;
  } else if (addrType === ATYP_DOMAIN) {
    addrLen = buffer[21];
    addr = buffer.slice(22, 22 + addrLen).toString();
  } else {
    return null;
  }
  return { cmd, port, addr, addrLen, totalLen: 22 + addrLen };
}

// 创建代理连接
function createOutboundConnection(targetAddr, targetPort, wsClient) {
  const outbound = net.connect(targetPort, targetAddr, () => {
    console.log(`Connected to ${targetAddr}:${targetPort}`);
  });

  // wsClient -> outbound
  wsClient.on('message', (data) => {
    if (outbound.destroyed) return;
    outbound.write(data);
  });

  // outbound -> wsClient
  outbound.on('data', (data) => {
    if (wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(data);
    }
  });

  outbound.on('end', () => {
    wsClient.close();
  });

  wsClient.on('close', () => {
    outbound.end();
  });

  outbound.on('error', (err) => {
    console.error('Outbound error:', err);
    wsClient.close();
  });

  wsClient.on('error', (err) => {
    console.error('WS error:', err);
    outbound.end();
  });
}

// HTTP 服务器（伪装 + WS 升级）
const server = http.createServer((req, res) => {
  if (req.url === VLESS_PATH) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(FAKE_PAGE);
});

// WS 升级处理
server.on('upgrade', (request, socket, head) => {
  if (request.url !== VLESS_PATH) {
    socket.destroy();
    return;
  }

  const ws = new WebSocket(undefined, undefined, { noServer: true });
  ws.shouldHandle = false;

  socket.on('data', (data) => {
    if (!ws.shouldHandle) {
      // 解析 VLESS 头
      const header = parseVLESSHeader(data);
      if (!header) {
        socket.destroy();
        return;
      }
      ws.shouldHandle = true;
      // 发送响应头（VLESS 握手响应）
      const response = Buffer.alloc(2);
      response[0] = VLESS_VERSION;
      response[1] = 0; // 成功
      socket.write(response);
      // 转发剩余数据
      if (data.length > header.totalLen) {
        ws.emit('message', data.slice(header.totalLen));
      }
      // 升级 socket 到 WS
      ws.handleUpgrade(request, socket, head, (wsInstance) => {
        server.emit('connection', wsInstance, request);
        // 创建代理
        createOutboundConnection(header.addr, header.port, wsInstance);
      });
    } else {
      ws.emit('message', data);
    }
  });

  socket.on('end', () => {
    ws.close();
  });
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`VLESS WS Server running on port ${PORT}, path: ${VLESS_PATH}`);
  console.log(`UUID: ${UUID}`);
  console.log(`VLESS URL: vless://${UUID}@your-app.back4app.io:443?type=ws&path=${VLESS_PATH}&security=tls#NodeJS-VLESS`);
});

// 错误处理
server.on('error', (err) => {
  console.error('Server error:', err);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

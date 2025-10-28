const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const net = require('net');

// 配置
const UUID = process.env.UUID || 'de04add9-5c68-8bab-950c-08cd5320df18';
const PORT = process.env.PORT || 3000;
const VLESS_PATH = process.env.VLESS_PATH || '/vl';

console.log('Starting VLESS Server...');
console.log(`UUID: ${UUID}`);
console.log(`PORT: ${PORT}`);
console.log(`VLESS_PATH: ${VLESS_PATH}`);

// VLESS 常量
const VLESS_VERSION = 0;
const ATYP_IP = 1;
const ATYP_DOMAIN = 3;

// 伪装页面
const FAKE_PAGE = '<!DOCTYPE html><html><body><h1>OK</h1></body></html>';

// UUID 验证
function validateUUID(uuidRaw) {
  try {
    const uuid = uuidRaw.toString('hex');
    return crypto.createHash('md5').update(uuid).digest('hex') === crypto.createHash('md5').update(UUID).digest('hex');
  } catch (err) {
    console.error('UUID validate error:', err.message);
    return false;
  }
}

// 解析 VLESS 头
function parseVLESSHeader(buffer) {
  try {
    if (buffer.length < 2) return null;
    const version = buffer[0];
    if (version !== VLESS_VERSION) return null;
    const uuidRaw = buffer.slice(1, 17);
    if (!validateUUID(uuidRaw)) return null;
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
  } catch (err) {
    console.error('Parse header error:', err.message);
    return null;
  }
}

// 创建代理连接
function createOutboundConnection(targetAddr, targetPort, wsClient) {
  console.log(`Creating connection to ${targetAddr}:${targetPort}`);
  const outbound = net.connect(targetPort, targetAddr, () => {
    console.log(`Connected to ${targetAddr}:${targetPort}`);
  });

  wsClient.on('message', (data) => {
    if (!outbound.destroyed) outbound.write(data);
  });

  outbound.on('data', (data) => {
    if (wsClient.readyState === WebSocket.OPEN) wsClient.send(data);
  });

  outbound.on('end', () => wsClient.close());
  wsClient.on('close', () => outbound.end());
  outbound.on('error', (err) => { 
    console.error('Outbound error:', err.message); 
    wsClient.close(); 
  });
  wsClient.on('error', (err) => { 
    console.error('WS error:', err.message); 
    outbound.end(); 
  });
}

// HTTP 服务器
const server = http.createServer((req, res) => {
  console.log(`HTTP request: ${req.method} ${req.url}`);
  if (req.url === VLESS_PATH) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(FAKE_PAGE);
});

// WS 升级
server.on('upgrade', (request, socket, head) => {
  console.log(`WS upgrade request: ${request.url}`);
  if (request.url !== VLESS_PATH) {
    console.log('Invalid WS path');
    socket.destroy();
    return;
  }

  let handled = false;
  socket.on('data', (data) => {
    if (handled) return;
    handled = true;
    try {
      console.log('Received WS data, length:', data.length);
      const header = parseVLESSHeader(data);
      if (!header) {
        console.log('Invalid VLESS header');
        socket.destroy();
        return;
      }
      console.log(`Valid header: ${header.addr}:${header.port}, cmd: ${header.cmd}`);
      
      const response = Buffer.alloc(2);
      response[0] = VLESS_VERSION;
      response[1] = 0;
      socket.write(response);
      
      const ws = new WebSocket(null, [], { noServer: true });
      ws.handleUpgrade(request, socket, head, (wsInstance) => {
        server.emit('connection', wsInstance, request);
        createOutboundConnection(header.addr, header.port, wsInstance);
        if (data.length > header.totalLen) {
          wsInstance.send(data.slice(header.totalLen));
        }
      });
    } catch (err) {
      console.error('WS upgrade error:', err.message);
      socket.destroy();
    }
  });

  socket.on('end', () => console.log('Socket end'));
  socket.on('error', (err) => console.error('Socket error:', err.message));
});

// 启动
server.listen(PORT, '0.0.0.0', () => {
  console.log(`VLESS WS Server started successfully on port ${PORT}, path: ${VLESS_PATH}`);
  console.log(`Full URL: vless://${UUID}@your-app.back4app.io:443?type=ws&path=${VLESS_PATH}&security=tls#NodeJS-VLESS`);
}).on('error', (err) => {
  console.error('Listen error:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const net = require('net');

// 配置
const UUID = process.env.UUID || 'de04add9-5c68-8bab-950c-08cd5320df18'; // 带 - 的标准 UUID
const PORT = process.env.PORT || 3000;
const VLESS_PATH = process.env.VLESS_PATH || '/vl';

console.log('Starting VLESS Server...');
console.log(`UUID: ${UUID}, PORT: ${PORT}, PATH: ${VLESS_PATH}`);

// 常量
const VLESS_VERSION = 0;
const ATYP_IP = 1;
const ATYP_DOMAIN = 3;

// 伪装页
const FAKE_PAGE = '<!DOCTYPE html><html><body><h1>OK - Proxy Active</h1></body></html>';

// UUID 验证 (标准 16 bytes raw)
function validateUUID(uuidRaw) {
  try {
    const clientUUID = uuidRaw.toString('hex');
    const serverUUID = UUID.replace(/-/g, '');
    return clientUUID === serverUUID;
  } catch (err) {
    console.error('UUID validate fail:', err.message);
    return false;
  }
}

// 解析头
function parseVLESSHeader(buffer) {
  try {
    console.log(`Parse buffer length: ${buffer.length}`);
    if (buffer.length < 18) {
      console.log('Buffer too short, waiting...');
      return null;
    }
    const version = buffer[0];
    if (version !== VLESS_VERSION) {
      console.log('Wrong version:', version);
      return null;
    }
    const uuidRaw = buffer.slice(1, 17);
    if (!validateUUID(uuidRaw)) {
      console.log('UUID mismatch');
      return null;
    }
    const port = buffer.readUInt16BE(17);
    const addrType = buffer[19];
    let addr, addrLen = 0;
    if (addrType === ATYP_IP) {
      addr = buffer.slice(20, 24).join('.');
      addrLen = 4;
    } else if (addrType === ATYP_DOMAIN) {
      addrLen = buffer[20];
      addr = buffer.slice(21, 21 + addrLen).toString();
    } else {
      console.log('Wrong addr type:', addrType);
      return null;
    }
    const totalLen = 21 + addrLen;
    console.log(`Parsed OK: ${addr}:${port}, totalLen: ${totalLen}`);
    return { port, addr, totalLen };
  } catch (err) {
    console.error('Parse error:', err.message);
    return null;
  }
}

// 代理连接
function createOutboundConnection(addr, port, wsClient) {
  console.log(`Connecting to ${addr}:${port}`);
  const outbound = net.connect(port, addr, () => {
    console.log(`Connected OK to ${addr}:${port}`);
  });
  wsClient.on('message', data => outbound.write(data));
  outbound.on('data', data => wsClient.send(data));
  outbound.on('end', () => wsClient.close());
  wsClient.on('close', () => outbound.end());
  outbound.on('error', err => { 
    console.error('Outbound error:', err.message); 
    wsClient.close(); 
  });
  wsClient.on('error', err => { 
    console.error('WS error:', err.message); 
    outbound.end(); 
  });
}

// HTTP 服务器
const server = http.createServer((req, res) => {
  console.log(`HTTP: ${req.method} ${req.url}`);
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
  console.log(`WS upgrade: ${request.url}`);
  if (request.url !== VLESS_PATH) {
    console.log('Invalid path');
    socket.destroy();
    return;
  }
  let buffer = Buffer.alloc(0);
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    console.log(`Received data, total buffer: ${buffer.length} bytes`);
    const header = parseVLESSHeader(buffer);
    if (!header) return; // 等数据
    try {
      const response = Buffer.alloc(2);
      response[0] = VLESS_VERSION;
      response[1] = 0;
      socket.write(response);
      console.log('Sent handshake response');
      const ws = new WebSocket(null, [], { noServer: true });
      ws.handleUpgrade(request, socket, head, wsInstance => {
        createOutboundConnection(header.addr, header.port, wsInstance);
        if (buffer.length > header.totalLen) {
          wsInstance.send(buffer.slice(header.totalLen));
        }
      });
    } catch (err) {
      console.error('WS setup error:', err.message);
      socket.destroy();
    }
  });
  socket.on('error', err => console.error('Socket error:', err.message));
});

// 启动
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server OK on ${PORT}! URL: vless://${UUID}@jjbao-3jyifa2g.b4a.run:443?type=ws&path=${VLESS_PATH}&security=tls#Test`);
}).on('error', err => {
  console.error('Listen fail:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

// main.ts - PRODUCTION VLESS SERVER (v2rayNG & ClashMeta Compatible)
import { exists } from "https://deno.land/std/fs/exists.ts";

const envUUID = Deno.env.get('UUID') || 'b3db873c-e53f-4884-98ee-4411972f9725';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'Deno-VLESS-Server';

const CONFIG_FILE = 'config.json';

interface Config {
  uuid?: string;
}

// UUID validation
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Get UUID from config
async function getUUIDFromConfig(): Promise<string | undefined> {
  try {
    if (await exists(CONFIG_FILE)) {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`✅ Loaded UUID from config`);
        return config.uuid;
      }
    }
  } catch (e) {
    console.log('Using new UUID');
  }
  return undefined;
}

// Save UUID to config
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`💾 Saved UUID to config`);
  } catch (e) {
    console.log('Cannot save config, using in-memory UUID');
  }
}

// Initialize UUID
let userID: string;

if (envUUID && isValidUUID(envUUID)) {
  userID = envUUID;
  console.log(`✅ Using UUID from environment: ${userID}`);
} else {
  const configUUID = await getUUIDFromConfig();
  if (configUUID) {
    userID = configUUID;
  } else {
    userID = crypto.randomUUID();
    console.log(`🆕 Generated new UUID: ${userID}`);
    await saveUUIDToConfig(userID);
  }
}

if (!isValidUUID(userID)) {
  userID = crypto.randomUUID();
  console.log(`🔄 Forced valid UUID: ${userID}`);
}

console.log(`🚀 PRODUCTION VLESS SERVER STARTED: ${userID}`);
console.log(`🌐 Server is ready`);

// WebSocket handler for VLESS protocol
async function vlessOverWSHandler(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  let address = '';
  let portWithRandomLog = '';
  
  const log = (info: string, event = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  let remoteSocketWapper: any = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  // Handle WebSocket stream
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWapper.value) {
            const writer = remoteSocketWapper.value.writable.getWriter();
            await writer.write(new Uint8Array(chunk));
            writer.releaseLock();
            return;
          }

          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processVlessHeader(chunk, userID);
          
          address = addressRemote;
          portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;
          
          if (hasError) {
            throw new Error(message);
          }

          if (isUDP) {
            if (portRemote === 53) {
              isDns = true;
            } else {
              throw new Error('UDP proxy only for DNS (port 53)');
            }
          }
          
          const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);

          if (isDns) {
            const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }
          
          handleTCPOutBound(
            remoteSocketWapper,
            addressRemote,
            portRemote,
            rawClientData,
            socket,
            vlessResponseHeader,
            log
          );
        },
        close() {
          log(`WebSocket stream closed`);
        },
        abort(reason) {
          log(`WebSocket stream aborted`, JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log('WebSocket stream error', err);
    });

  return response;
}

// Make readable WebSocket stream
function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: (info: string, event?: string) => void) {
  let readableStreamCancel = false;
  
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });
      
      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket error');
        controller.error(err);
      });
      
      // Early data handling
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`Stream canceled: ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });

  return stream;
}

// Process VLESS header
function processVlessHeader(vlessBuffer: ArrayBuffer, userID: string) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data' };
  }
  
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
    isValidUser = true;
  }
  
  if (!isValidUser) {
    return { hasError: true, message: 'Invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  if (command === 1) {
    // TCP
  } else if (command === 2) {
    isUDP = true;
  } else {
    return { hasError: true, message: `Unsupported command: ${command}` };
  }
  
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}` };
  }

  if (!addressValue) {
    return { hasError: true, message: 'Empty address' };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

// Handle TCP outbound connections
async function handleTCPOutBound(
  remoteSocket: { value: any },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    const tcpSocket = await Deno.connect({
      port: port,
      hostname: address,
    });

    remoteSocket.value = tcpSocket;
    log(`✅ Connected to ${address}:${port}`);
    
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    
    return tcpSocket;
  }

  const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
}

// WebSocket to remote socket
async function remoteSocketToWS(remoteSocket: Deno.TcpConn, webSocket: WebSocket, vlessResponseHeader: Uint8Array, retry: (() => Promise<void>) | null, log: (info: string, event?: string) => void) {
  let hasIncomingData = false;
  
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          hasIncomingData = true;
          
          if (webSocket.readyState !== WS_READY_STATE_OPEN) {
            controller.error('WebSocket not open');
          }

          if (vlessResponseHeader) {
            webSocket.send(new Uint8Array([...vlessResponseHeader, ...chunk]));
            vlessResponseHeader = null;
          } else {
            webSocket.send(chunk);
          }
        },
        close() {
          log(`Remote connection closed, had incoming data: ${hasIncomingData}`);
        },
        abort(reason) {
          console.error('Remote connection aborted', reason);
        },
      })
    )
    .catch((error) => {
      console.error('Remote to WS error', error);
      safeCloseWebSocket(webSocket);
    });

  if (!hasIncomingData && retry) {
    log(`Retrying connection`);
    retry();
  }
}

// Handle UDP outbound (DNS)
async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: (info: string) => void) {
  let isVlessHeaderSent = false;
  
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const resp = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk,
          });
          
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
          
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`DNS query successful: ${udpSize} bytes`);
            
            if (isVlessHeaderSent) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
              isVlessHeaderSent = true;
            }
          }
        },
      })
    )
    .catch((error) => {
      log('DNS UDP error: ' + error);
    });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}

// Utility functions
function base64ToArrayBuffer(base64Str: string) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error: error };
  }
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket: WebSocket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('Safe close error', error);
  }
}

// UUID stringify function
const byteToHex: string[] = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function stringify(arr: Uint8Array, offset = 0) {
  return (
    byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

// Generate configurations for v2rayNG and ClashMeta
function generateConfigs(host: string, uuid: string) {
  // v2rayNG compatible config
  const vlessURL = `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2F#${credit}`;
  
  // ClashMeta compatible config
  const clashConfig = `
# ClashMeta Configuration
- name: ${credit}
  type: vless
  server: ${host}
  port: 443
  uuid: ${uuid}
  network: ws
  tls: true
  udp: true
  sni: ${host}
  client-fingerprint: chrome
  ws-opts:
    path: "/"
    headers:
      host: ${host}
`.trim();

  // Alternative v2rayNG config with different path
  const vlessURLAlt = `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}&path=%2Fwebsocket#${credit}-ws`;

  // ClashMeta config for Android
  const clashAndroidConfig = `
# ClashMeta Android Config
proxies:
  - name: "${credit}"
    type: vless
    server: ${host}
    port: 443
    uuid: ${uuid}
    network: ws
    tls: true
    udp: true
    sni: ${host}
    client-fingerprint: chrome
    ws-opts:
      path: "/"
      headers:
        Host: ${host}
`.trim();

  return { 
    vlessURL, 
    vlessURLAlt,
    clashConfig,
    clashAndroidConfig 
  };
}

// QR Code generator URL
function getQRCodeUrl(text: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
}

// Main server
Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const host = url.hostname;
  const protocol = url.protocol;

  const upgrade = request.headers.get('upgrade') || '';
  if (upgrade.toLowerCase() != 'websocket') {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/': {
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 VLESS Server</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: rgba(255,255,255,0.98);
            padding: 40px;
            border-radius: 30px;
            box-shadow: 0 30px 60px rgba(0,0,0,0.3);
            max-width: 1200px;
            width: 100%;
            backdrop-filter: blur(10px);
        }
        h1 {
            color: #2c3e50;
            margin-bottom: 20px;
            font-size: 2.5em;
            text-align: center;
        }
        .badge {
            background: linear-gradient(135deg, #28a745, #20c997);
            color: white;
            padding: 15px 30px;
            border-radius: 50px;
            display: inline-block;
            margin: 20px auto;
            font-weight: bold;
            font-size: 1.2em;
            box-shadow: 0 5px 15px rgba(40,167,69,0.3);
        }
        .client-section {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 30px;
            margin: 40px 0;
        }
        .client-card {
            background: #f8f9fa;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            transition: transform 0.3s;
        }
        .client-card:hover {
            transform: translateY(-5px);
        }
        .client-card h2 {
            color: #495057;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .client-card h2 img {
            width: 30px;
            height: 30px;
        }
        .config-box {
            background: #e9ecef;
            padding: 20px;
            border-radius: 15px;
            margin: 20px 0;
            position: relative;
        }
        .config-box pre {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            margin: 10px 0;
        }
        .btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 10px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            margin: 5px;
            transition: all 0.3s;
            text-decoration: none;
            display: inline-block;
        }
        .btn:hover {
            background: #0056b3;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,123,255,0.3);
        }
        .btn-success {
            background: #28a745;
        }
        .btn-success:hover {
            background: #218838;
        }
        .qr-code {
            text-align: center;
            margin: 20px 0;
        }
        .qr-code img {
            max-width: 200px;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        .download-section {
            text-align: center;
            margin: 30px 0;
            padding: 20px;
            background: #e3f2fd;
            border-radius: 15px;
        }
        .footer {
            text-align: center;
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px solid #dee2e6;
            color: #6c757d;
        }
        @media (max-width: 768px) {
            .client-section {
                grid-template-columns: 1fr;
            }
            .container {
                padding: 20px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 VLESS Server</h1>
        <div style="text-align: center;">
            <span class="badge">✅ Server Online</span>
        </div>
        
        <div class="download-section">
            <h3>📱 Download Apps</h3>
            <a href="https://play.google.com/store/apps/details?id=com.v2ray.ang" target="_blank" class="btn">v2rayNG (Android)</a>
            <a href="https://play.google.com/store/apps/details?id=com.github.metacubex.clash.meta" target="_blank" class="btn btn-success">ClashMeta (Android)</a>
        </div>

        <div class="client-section">
            <!-- v2rayNG Section -->
            <div class="client-card">
                <h2>
                    <span>📱 v2rayNG</span>
                </h2>
                <div class="config-box">
                    <strong>VLESS URL:</strong>
                    <pre id="vless-url"></pre>
                    <button class="btn" onclick="copyToClipboard('vless-url')">📋 Copy URL</button>
                </div>
                <div class="qr-code">
                    <strong>QR Code:</strong>
                    <div id="vless-qr"></div>
                </div>
                <details>
                    <summary style="cursor: pointer; color: #007bff;">Manual Configuration</summary>
                    <div style="margin-top: 15px;">
                        <p><strong>Address:</strong> <span id="host-display"></span></p>
                        <p><strong>Port:</strong> 443</p>
                        <p><strong>UUID:</strong> <span id="uuid-display"></span></p>
                        <p><strong>Security:</strong> tls</p>
                        <p><strong>Network:</strong> ws</p>
                        <p><strong>Path:</strong> /</p>
                        <p><strong>SNI:</strong> <span id="sni-display"></span></p>
                        <p><strong>Fingerprint:</strong> chrome</p>
                    </div>
                </details>
            </div>

            <!-- ClashMeta Section -->
            <div class="client-card">
                <h2>
                    <span>⚡ ClashMeta</span>
                </h2>
                <div class="config-box">
                    <strong>YAML Configuration:</strong>
                    <pre id="clash-config"></pre>
                    <button class="btn" onclick="copyToClipboard('clash-config')">📋 Copy YAML</button>
                    <button class="btn btn-success" onclick="downloadClashConfig()">⬇️ Download YAML</button>
                </div>
                <details>
                    <summary style="cursor: pointer; color: #007bff;">Import Instructions</summary>
                    <div style="margin-top: 15px;">
                        <p>1. Copy the YAML configuration</p>
                        <p>2. Open ClashMeta app</p>
                        <p>3. Go to Profiles → New Profile</p>
                        <p>4. Paste configuration</p>
                        <p>5. Save and select profile</p>
                    </div>
                </details>
            </div>
        </div>

        <div style="text-align: center; margin-top: 30px;">
            <a href="/config-json" class="btn">📋 Get JSON Config</a>
            <a href="/status" class="btn btn-success">🔍 Server Status</a>
        </div>

        <div class="footer">
            <p>🚀 Server is ready for v2rayNG & ClashMeta</p>
            <p>UUID: <span id="footer-uuid"></span></p>
        </div>
    </div>

    <script>
        const host = window.location.hostname;
        const protocol = window.location.protocol;
        const uuid = "${userID}";
        
        // Generate vless URL
        const vlessURL = \`vless://\${uuid}@\${host}:443?encryption=none&security=tls&sni=\${host}&fp=chrome&type=ws&host=\${host}&path=%2F#Deno-VLESS\`;
        
        // Generate Clash config
        const clashConfig = \`proxies:
  - name: "Deno-VLESS"
    type: vless
    server: \${host}
    port: 443
    uuid: \${uuid}
    network: ws
    tls: true
    udp: true
    sni: \${host}
    client-fingerprint: chrome
    ws-opts:
      path: "/"
      headers:
        Host: \${host}\`;
        
        // Display values
        document.getElementById('vless-url').textContent = vlessURL;
        document.getElementById('clash-config').textContent = clashConfig;
        document.getElementById('host-display').textContent = host;
        document.getElementById('uuid-display').textContent = uuid;
        document.getElementById('sni-display').textContent = host;
        document.getElementById('footer-uuid').textContent = uuid;
        
        // Generate QR codes
        const qrApi = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=';
        document.getElementById('vless-qr').innerHTML = \`<img src="\${qrApi}\${encodeURIComponent(vlessURL)}" alt="QR Code">\`;
        
        function copyToClipboard(elementId) {
            const text = document.getElementById(elementId).textContent;
            navigator.clipboard.writeText(text).then(() => {
                alert('✅ Copied to clipboard!');
            });
        }
        
        function downloadClashConfig() {
            const blob = new Blob([clashConfig], { type: 'text/yaml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'clash-config.yaml';
            a.click();
            URL.revokeObjectURL(url);
        }
    </script>
</body>
</html>`;
        return new Response(htmlContent, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      
      case '/config-json': {
        const configs = generateConfigs(host, userID);
        return Response.json({
          server: {
            host: host,
            port: 443,
            uuid: userID,
            protocol: 'vless',
            network: 'ws',
            security: 'tls',
            path: '/',
            sni: host
          },
          clients: {
            v2rayNG: {
              url: configs.vlessURL,
              alternative: configs.vlessURLAlt
            },
            clashMeta: {
              yaml: configs.clashConfig,
              android: configs.clashAndroidConfig
            }
          },
          timestamp: new Date().toISOString()
        });
      }
      
      case '/status':
        return Response.json({
          status: 'online',
          server: host,
          uuid: userID,
          clients: ['v2rayNG', 'ClashMeta'],
          timestamp: new Date().toISOString()
        });
      
      case '/configs':
        const configs = generateConfigs(host, userID);
        return Response.json({
          vless_url: configs.vlessURL,
          vless_url_alt: configs.vlessURLAlt,
          clash_config: configs.clashConfig,
          clash_android: configs.clashAndroidConfig,
          uuid: userID,
          host: host
        });
      
      default:
        return new Response('Not found', { status: 404 });
    }
  } else {
    return await vlessOverWSHandler(request);
  }
});

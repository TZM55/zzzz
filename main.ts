import { exists } from "https://deno.land/std/fs/exists.ts";

const envUUID = Deno.env.get('UUID') || 'e5185305-1984-4084-81e0-f77271159c62';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'DenoBy-Gemini'; 

const CONFIG_FILE = 'config.json'; 

interface Config {
  uuid?: string;
}

async function getUUIDFromConfig(): Promise<string | undefined> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) return config.uuid;
    } catch (e) { console.warn(`Error reading config:`, e.message); }
  }
  return undefined;
}

async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid: uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) { console.error(`Failed to save UUID:`, e.message); }
}

let userID: string;
if (envUUID && isValidUUID(envUUID)) {
  userID = envUUID;
} else {
  const configUUID = await getUUIDFromConfig();
  if (configUUID) {
    userID = configUUID;
  } else {
    userID = crypto.randomUUID();
    await saveUUIDToConfig(userID);
  }
}

Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  const url = new URL(request.url);
  const hostName = url.hostname;

  if (upgrade.toLowerCase() !== 'websocket') {
    // Clash Meta Configuration Path
    if (url.pathname === '/clash') {
      const clashConfig = `
port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: info
proxies:
  - type: vless
    name: "Deno-VLESS-Node"
    server: ${hostName}
    port: 443
    uuid: ${userID}
    network: ws
    tls: true
    udp: true
    sni: ${hostName}
    client-fingerprint: chrome
    ws-opts:
      path: "/?ed=2048"
      headers:
        host: ${hostName}
proxy-groups:
  - name: "Proxy-Selection"
    type: select
    proxies:
      - "Deno-VLESS-Node"
      - DIRECT
rules:
  - MATCH,Proxy-Selection
`;
      return new Response(clashConfig, { headers: { 'Content-Type': 'text/yaml; charset=utf-8' } });
    }

    // Default UI Page
    const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${credit}`;
    
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head><title>Deno Proxy Control Panel</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
    <body style="font-family: sans-serif; background: #f4f4f9; padding: 20px; text-align: center;">
      <div style="background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); max-width: 500px; margin: auto;">
        <h1 style="color: #007bff;">🚀 Deno Proxy Online</h1>
        <p><strong>UUID:</strong> <code style="background: #eee; padding: 5px;">${userID}</code></p>
        <hr/>
        <h3>1. For Clash Meta (Android/PC)</h3>
        <p>Copy this URL and use "Import from URL":</p>
        <input type="text" value="https://${hostName}/clash" style="width: 100%; padding: 10px; margin-bottom: 10px;" readonly onClick="this.select();">
        <hr/>
        <h3>2. For v2rayNG (VLESS URI)</h3>
        <textarea style="width: 100%; height: 80px; padding: 10px;" readonly onClick="this.select();">${vlessMain}</textarea>
      </div>
    </body>
    </html>`;
    
    return new Response(htmlContent, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  return await vlessOverWSHandler(request);
});

async function vlessOverWSHandler(request: Request) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  let address = '';
  let portWithRandomLog = '';
  const log = (info: string, event = '') => { console.log(`[${address}:${portWithRandomLog}] ${info}`, event); };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  let remoteSocketWapper: any = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
      if (remoteSocketWapper.value) {
        const writer = remoteSocketWapper.value.writable.getWriter();
        await writer.write(new Uint8Array(chunk));
        writer.releaseLock();
        return;
      }
      const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processVlessHeader(chunk, userID);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
      if (hasError) throw new Error(message);
      if (isUDP && portRemote === 53) isDns = true;
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isDns) {
        const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, socket, vlessResponseHeader, log);
    },
    close() { log(`WS Stream Closed`); },
    abort(reason) { log(`WS Stream Aborted`, JSON.stringify(reason)); }
  })).catch((err) => { log('Pipe Error', err); });

  return response;
}

async function handleTCPOutBound(remoteSocket: any, addressRemote: string, portRemote: number, rawClientData: Uint8Array, webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: any) {
  async function connectAndWrite(address: string, port: number) {
    const tcpSocket = await Deno.connect({ port: port, hostname: address });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    return tcpSocket;
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
}

function makeReadableWebSocketStream(webSocketServer: WebSocket, earlyDataHeader: string, log: any) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (!readableStreamCancel) controller.enqueue(event.data);
      });
      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (!readableStreamCancel) controller.close();
      });
      webSocketServer.addEventListener('error', (err) => controller.error(err));
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error); else if (earlyData) controller.enqueue(earlyData);
    },
    cancel() { readableStreamCancel = true; safeCloseWebSocket(webSocketServer); }
  });
}

function processVlessHeader(vlessBuffer: ArrayBuffer, userID: string) {
  if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) !== userID) return { hasError: true, message: 'invalid user' };
  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  const isUDP = command === 2;
  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
  let addressValue = '', addressLength = 0;
  if (addressType === 1) {
    addressLength = 4;
    addressValue = new Uint8Array(vlessBuffer.slice(addressIndex + 1, addressIndex + 1 + 4)).join('.');
  } else if (addressType === 2) {
    addressLength = new Uint8Array(vlessBuffer.slice(addressIndex + 1, addressIndex + 2))[0];
    addressValue = new TextDecoder().decode(vlessBuffer.slice(addressIndex + 2, addressIndex + 2 + addressLength));
    addressLength++;
  } else if (addressType === 3) {
    addressLength = 16;
    const dataView = new DataView(vlessBuffer.slice(addressIndex + 1, addressIndex + 17));
    const ipv6 = []; for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
    addressValue = ipv6.join(':');
  }
  return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressIndex + 1 + addressLength, vlessVersion: version, isUDP };
}

async function remoteSocketToWS(remoteSocket: Deno.TcpConn, webSocket: WebSocket, vlessResponseHeader: any, retry: any, log: any) {
  let header = vlessResponseHeader;
  await remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (webSocket.readyState !== 1) return;
      if (header) { webSocket.send(new Uint8Array([...header, ...chunk])); header = null; }
      else webSocket.send(chunk);
    }
  })).catch((e) => safeCloseWebSocket(webSocket));
}

function base64ToArrayBuffer(base64Str: string) {
  if (!base64Str) return { error: null };
  try {
    const b64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(b64);
    return { earlyData: Uint8Array.from(decode, (c) => c.charCodeAt(0)).buffer, error: null };
  } catch (e) { return { error: e }; }
}

function isValidUUID(uuid: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid); }

function safeCloseWebSocket(socket: WebSocket) { try { if (socket.readyState < 2) socket.close(); } catch (e) {} }

const byteToHex: string[] = []; for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
function stringify(arr: Uint8Array) {
  let i = 0;
  const uuid = (byteToHex[arr[i++]] + byteToHex[arr[i++]] + byteToHex[arr[i++]] + byteToHex[arr[i++]] + '-' + byteToHex[arr[i++]] + byteToHex[arr[i++]] + '-' + byteToHex[arr[i++]] + byteToHex[arr[i++]] + '-' + byteToHex[arr[i++]] + byteToHex[arr[i++]] + '-' + byteToHex[arr[i++]] + byteToHex[arr[i++]] + byteToHex[arr[i++]] + byteToHex[arr[i++]] + byteToHex[arr[i++]] + byteToHex[arr[i++]]).toLowerCase();
  if (!isValidUUID(uuid)) throw TypeError('Invalid UUID');
  return uuid;
}

async function handleUDPOutBound(webSocket: WebSocket, vlessResponseHeader: Uint8Array, log: any) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const length = new DataView(chunk.slice(index, index + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(index + 2, index + 2 + length)));
        index += 2 + length;
      }
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch('https://1.1.1.1/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk });
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
      if (webSocket.readyState === 1) {
        if (isVlessHeaderSent) webSocket.send(new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
        else { webSocket.send(new Uint8Array([...vlessResponseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])); isVlessHeaderSent = true; }
      }
    }
  }));
  const writer = transformStream.writable.getWriter();
  return { write(chunk: Uint8Array) { writer.write(chunk); } };
}

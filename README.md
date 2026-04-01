# Jarvis Browser Bridge

WebSocket bridge server that lets Jarvis (on Zo) control Chrome on your Mac via Playwright CDP.

## Setup

```bash
cd ~/jarvis-browser-bridge
npm install
```

## Usage

### 1. Launch Chrome with CDP

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
```

### 2. Start the bridge

```bash
JARVIS_BRIDGE_TOKEN=your-secret-token node server.js
```

### 3. Test with wscat

```bash
npx wscat -c ws://localhost:3456
> {"type": "auth", "token": "your-secret-token"}
< {"type":"auth","status":"ok"}
> {"id": "1", "action": "navigate_and_extract", "url": "https://example.com", "extract": "text"}
< {"id":"1","type":"progress","message":"Navigating to https://example.com..."}
< {"id":"1","type":"result","url":"https://example.com/","title":"Example Domain","content":"..."}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JARVIS_BRIDGE_TOKEN` | Yes | — | Auth token for WebSocket connections |
| `PORT` | No | 3456 | Server port |
| `CDP_URL` | No | http://localhost:9222 | Chrome CDP endpoint |

## Health Check

```bash
curl http://localhost:3456/health
```

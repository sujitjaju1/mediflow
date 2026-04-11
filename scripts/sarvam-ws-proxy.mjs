import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config({ path: ".env.local" });

const apiKey = process.env.SARVAM_API_KEY;
if (!apiKey) {
  console.error("Missing SARVAM_API_KEY");
  process.exit(1);
}

const port = Number(process.env.SARVAM_WS_PROXY_PORT ?? 8787);
const host = process.env.SARVAM_WS_PROXY_HOST ?? "127.0.0.1";
const server = new WebSocketServer({ host, port, path: "/speech-to-text/ws" });

console.log(`Sarvam STT proxy listening on ws://${host}:${port}/speech-to-text/ws`);

const pcm16ToWav = (pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) => {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const wavBuffer = Buffer.alloc(44 + dataSize);

  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataSize, 4);
  wavBuffer.write("WAVE", 8);
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);
  wavBuffer.writeUInt16LE(1, 20);
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wavBuffer, 44);

  return wavBuffer;
};

server.on("connection", (clientSocket, request) => {
  const requestUrl = new URL(request.url ?? "/speech-to-text/ws", `ws://${host}:${port}`);
  const query = new URLSearchParams(requestUrl.searchParams);
  const sampleRate = Number(query.get("sample_rate") ?? "16000");

  console.log("Sarvam proxy client connected", requestUrl.searchParams.toString());

  const upstreamQuery = new URLSearchParams(query);
  const upstreamUrl = `wss://api.sarvam.ai/speech-to-text/ws?${upstreamQuery.toString()}`;

  const upstreamSocket = new WebSocket(upstreamUrl, [`api-subscription-key.${apiKey}`], {
    headers: {
      "Api-Subscription-Key": apiKey,
    },
  });

  const closePeer = (socket, code = 1000, reason = "") => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  };

  clientSocket.on("message", (message, isBinary) => {
    if (upstreamSocket.readyState !== WebSocket.OPEN) return;

    if (!isBinary) {
      const text = String(message);
      if (text.trim() === "{\"type\":\"flush\"}" || text.trim() === "flush") {
        upstreamSocket.send(JSON.stringify({ type: "flush" }));
        return;
      }

      try {
        const parsed = JSON.parse(text);
        if (parsed?.type === "flush") {
          upstreamSocket.send(JSON.stringify({ type: "flush" }));
          return;
        }
      } catch {
        // ignore non-JSON control messages
      }
    }

    const buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const wavBuffer = pcm16ToWav(buffer, sampleRate, 1, 16);
    const base64 = wavBuffer.toString("base64");
    console.log("Sarvam proxy audio frame", buffer.length, "bytes");
    upstreamSocket.send(
      JSON.stringify({
        audio: {
          data: base64,
          sample_rate: String(sampleRate),
          encoding: "audio/wav",
        },
      })
    );
  });

  clientSocket.on("close", (code, reason) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      try {
        upstreamSocket.send(JSON.stringify({ type: "flush" }));
      } catch {
        // ignore flush errors during shutdown
      }
      setTimeout(() => closePeer(upstreamSocket, code, reason.toString()), 200);
    } else {
      closePeer(upstreamSocket, code, reason.toString());
    }
  });

  clientSocket.on("error", () => {
    closePeer(upstreamSocket, 1011, "client error");
  });

  upstreamSocket.on("open", () => {
    console.log("Sarvam upstream open");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({ type: "events", data: { event_type: "proxy_ready" } }));
    }
  });

  upstreamSocket.on("message", (data) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data.toString());
    }
  });

  upstreamSocket.on("close", (code, reason) => {
    console.log("Sarvam upstream close", code, reason.toString());
    closePeer(clientSocket, code, reason.toString());
  });

  upstreamSocket.on("error", (error) => {
    console.error("Sarvam upstream error", error);
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(
        JSON.stringify({
          type: "error",
          data: {
            error: error instanceof Error ? error.message : "Sarvam websocket proxy error",
            code: "proxy_error",
          },
        })
      );
    }
    closePeer(clientSocket, 1011, "upstream error");
  });
});

server.on("error", (error) => {
  console.error("Sarvam STT proxy error:", error);
  process.exit(1);
});

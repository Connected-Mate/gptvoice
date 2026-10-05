// A local stand-in for the OpenAI realtime WebSocket, scripted per test.
import http from "node:http";
import { WebSocketServer } from "ws";

// Generate a short PCM16 tone (so trimSilence keeps it).
export function tone(ms = 400, rate = 24000) {
  const n = Math.round((ms / 1000) * rate);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  return b;
}

/**
 * behaviors: array consumed one per connection; each is a function
 * ({ ws, req, send, msgs }) or a { status } object for handshake rejection.
 */
export async function startMock(behaviors) {
  const connections = [];
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const b = behaviors[Math.min(connections.length, behaviors.length - 1)];
    connections.push({ url: req.url, headers: req.headers, messages: [] });
    if (b && typeof b === "object" && b.status) {
      socket.write(`HTTP/1.1 ${b.status} Nope\r\nContent-Type: application/json\r\nContent-Length: ${(b.body || "").length}\r\n\r\n${b.body || ""}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = connections[connections.length - 1];
      const send = (o) => ws.send(JSON.stringify(o));
      ws.on("message", (d) => conn.messages.push(JSON.parse(String(d))));
      b({ ws, send, conn });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/v1/realtime`;
  return {
    url,
    connections,
    close: () =>
      new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(r);
      }),
  };
}

// Standard well-behaved TTS session: speaks `spoken` (default: the text sent).
export function ttsBehavior({ spoken, audioMs = 400, failWith } = {}) {
  return ({ ws, send, conn }) => {
    send({ type: "session.created", session: {} });
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "session.update") {
        if (failWith) return send({ type: "error", error: failWith });
        send({ type: "session.updated", session: m.session });
      }
      if (m.type === "response.create") {
        const instr = conn.messages.find((x) => x.type === "session.update")?.session?.instructions ?? "";
        const text = instr.split('"""')[1]?.trim() ?? "";
        const pcm = Buffer.concat([Buffer.alloc(4800), tone(audioMs), Buffer.alloc(4800)]);
        for (let i = 0; i < pcm.length; i += 4800) {
          send({ type: "response.output_audio.delta", delta: pcm.subarray(i, i + 4800).toString("base64") });
        }
        send({ type: "response.output_audio_transcript.done", transcript: spoken ?? text });
        send({ type: "response.done", response: { status: "completed", usage: { total_tokens: 1 } } });
      }
    });
  };
}

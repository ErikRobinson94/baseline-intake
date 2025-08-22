import http from "node:http";
import next from "next";
import morgan from "morgan";
import { WebSocketServer } from "ws";

const dev = process.env.NODE_ENV !== "production";
const port = process.env.PORT || 10000;

const app = next({ dev, dir: "." });
const handle = app.getRequestHandler();

// --- WS servers (path-scoped via manual upgrade) ---
const wssEcho = new WebSocketServer({ noServer: true });
const wssPing = new WebSocketServer({ noServer: true });
const wssDemo = new WebSocketServer({ noServer: true });

wssEcho.on("connection", (ws) => {
  ws.once("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary }); // echo once
    setTimeout(() => ws.close(1000, "clean"), 50);
  });
});

wssPing.on("connection", (ws) => {
  const id = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send("pong");
  }, 2000);
  ws.on("close", () => clearInterval(id));
});

wssDemo.on("connection", (ws) => {
  ws.send("demo: handshake ok");
});

await app.prepare();

const server = http.createServer((req, res) => {
  // tiny http logger (morgan) without Express
  morgan("tiny")(req, res, () => handle(req, res));
});

// Manual upgrade routing
server.on("upgrade", (req, socket, head) => {
  const { url = "" } = req;
  if (url === "/ws-echo") {
    wssEcho.handleUpgrade(req, socket, head, (ws) =>
      wssEcho.emit("connection", ws, req)
    );
  } else if (url === "/ws-ping") {
    wssPing.handleUpgrade(req, socket, head, (ws) =>
      wssPing.emit("connection", ws, req)
    );
  } else if (url === "/web-demo/ws") {
    wssDemo.handleUpgrade(req, socket, head, (ws) =>
      wssDemo.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

server.listen(port, () => {
  console.log("server_listen", { url: `http://0.0.0.0:${port}` });
});

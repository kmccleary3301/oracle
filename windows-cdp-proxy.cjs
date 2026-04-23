#!/usr/bin/env node
const net = require("node:net");

const listenPort = Number(process.argv[2] || 33792);
const targetPort = Number(process.argv[3] || 33791);
const listenHost = process.argv[4] || "0.0.0.0";
const targetHost = process.argv[5] || "127.0.0.1";

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
});

server.listen(listenPort, listenHost, () => {
  console.log(`cdp proxy ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
});

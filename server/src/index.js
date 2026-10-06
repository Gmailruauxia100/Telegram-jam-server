import { config } from "./config.js";
import { createJamServer } from "./server.js";

const server = createJamServer(config);

server.listen()
  .then((address) => {
    console.log(`Telegram Jam listening on ws://${address.address}:${address.port}${config.pathname}`);
  })
  .catch((error) => {
    console.error("Failed to start Telegram Jam:", error);
    process.exitCode = 1;
  });

function shutdown(signal) {
  console.log(`Received ${signal}, stopping Telegram Jam...`);
  server.close().finally(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

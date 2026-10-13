import { defineConfig } from "vite";

// Editing Panel's own UI is routine while Panel is also hosting a live terminal session — this
// project IS its own dev environment. Vite's default full-page reload forgets which xterm panes
// were adopted even though the backend PTYs survive, which is what messes up the session. main.ts
// reports session liveness here so the reload can be deferred instead of dropped: the next save
// after sessions end reloads normally.
let sessionsActive = false;

export default defineConfig({
  plugins: [
    {
      name: "panel-defer-reload-during-sessions",
      configureServer(server) {
        server.middlewares.use("/__panel-sessions", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end();
            return;
          }
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              sessionsActive = JSON.parse(body || "{}").active === true;
            } catch {
              // malformed beacon — leave the last known state alone
            }
            res.end("ok");
          });
        });
      },
      handleHotUpdate(ctx) {
        if (sessionsActive) {
          ctx.server.config.logger.info(
            `[panel] reload deferred — a terminal session is live (${ctx.file})`,
            { timestamp: true },
          );
          return [];
        }
      },
    },
  ],
});

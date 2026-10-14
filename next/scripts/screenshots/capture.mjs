/**
 * Regenerates the README screenshots in docs/screenshots/.
 *
 * The real UI runs in headless WebKit, the engine the macOS app uses, against demo-backend.js.
 * No window opens and nothing on your machine is read, so the shots never show your projects.
 *
 *   cd next/scripts/screenshots
 *   npm install && npx playwright install webkit
 *   npm run capture              # every shot
 *   npm run capture -- home      # only the named ones
 *
 * Set PANEL_UI_URL to reuse a running `npm run dev` instead of starting Vite here.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webkit } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const ui = join(repo, "next", "apps", "desktop", "ui");
const out = join(repo, "docs", "screenshots");
const PORT = 1488;

/** Start the UI's own Vite on a port nothing else uses, and wait until it serves. */
async function startVite() {
  const vite = spawn(join(ui, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    cwd: ui,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error("Vite did not start in 30 s")), 30_000);
    vite.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready in")) {
        clearTimeout(timer);
        ready();
      }
    });
    vite.on("exit", (code) => fail(new Error(`Vite exited with ${code}. Run npm ci in ${ui} first.`)));
  });
  return vite;
}

const settle = (page, ms = 600) => page.waitForTimeout(ms);

/** Each shot starts from a fresh, booted app with the demo playing. */
const SHOTS = [
  {
    name: "home",
    async prepare(page) {
      await page.click("#homeButton");
    },
  },
  {
    name: "project",
    async prepare(page) {
      await page.click('#projectList [data-project-id="tavla"]');
    },
  },
  {
    name: "dashboard",
    async prepare(page) {
      await page.click('#projectList [data-project-id="tavla"]');
      await settle(page);
      await page.click("#tabDash");
    },
  },
  {
    name: "work",
    async prepare(page) {
      await page.click('#projectList [data-project-id="tavla"]');
      await settle(page);
      await page.click("#tabFiles");
      await settle(page);
      const tree = page.locator("#filesPane");
      for (const name of ["lib", "game", "doubling_cube.dart"]) {
        await tree.getByText(name, { exact: true }).first().click();
        await settle(page, 300);
      }
      // Land on the agent's edit, so the change marks in the gutter are on screen.
      await page.locator(".cm-line", { hasText: "void resign" }).evaluate((line) => line.scrollIntoView({ block: "center" }));
    },
  },
  {
    // The README's first image: every agent at once, in the dark theme.
    name: "hero",
    dark: true,
    async prepare(page) {
      await page.click("#terminalsButton");
    },
  },
  {
    // The other terminal layout: a row of terminal tabs under the strip, one terminal at a time.
    name: "tabs",
    async prepare(page) {
      await page.click("#terminalsButton");
      await settle(page);
      await page.click('.terms-layout-item[aria-label="Tabs layout"]');
    },
  },
  {
    name: "reports",
    async prepare(page) {
      await page.click("#chatButton");
    },
  },
  {
    // The README's top image. A static page, not the app, and it shows hero.png, so it runs last.
    name: "banner",
    page: "banner.html",
    viewport: { width: 1280, height: 640 },
  },
];

const wanted = process.argv.slice(2);
const shots = wanted.length ? SHOTS.filter((shot) => wanted.includes(shot.name)) : SHOTS;
if (!shots.length) throw new Error(`No shot named ${wanted.join(", ")}. Known: ${SHOTS.map((s) => s.name).join(", ")}`);

const vite = process.env.PANEL_UI_URL ? null : await startVite();
const url = process.env.PANEL_UI_URL ?? `http://127.0.0.1:${PORT}/`;
await mkdir(out, { recursive: true });
const written = [];
const browser = await webkit.launch();
try {
  for (const shot of shots) {
    const page = await browser.newPage({
      viewport: shot.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: shot.dark ? "dark" : "light",
    });
    page.on("console", (message) => {
      if (message.text().startsWith("[demo]") || message.type() === "error") console.log(`  ${shot.name}: ${message.text()}`);
    });
    page.on("pageerror", (error) => console.log(`  ${shot.name}: page error ${error.message}`));
    if (shot.page) {
      await page.goto(pathToFileURL(join(here, shot.page)).href, { waitUntil: "load" });
    } else {
      await page.addInitScript({ path: join(here, "demo-backend.js") });
      await page.goto(url);
      await page.waitForSelector("#panelBoot", { state: "detached", timeout: 15_000 }).catch(() => undefined);
      await page.evaluate(() => window.__panelDemo.play());
      await settle(page);
      await shot.prepare(page);
    }
    await settle(page, 900);
    const file = join(out, `${shot.name}.png`);
    await page.screenshot({ path: file });
    written.push(file);
    console.log(`wrote ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  vite?.kill();
}

// Retina PNGs are large. pngquant cuts them to about a third with no visible change; without it
// the shots are still correct, just heavier in git.
const squeezed = spawnSync("pngquant", ["--force", "--skip-if-larger", "--ext", ".png", "--quality", "80-98", ...written]);
if (squeezed.error) console.log("pngquant not found, so the PNGs stay uncompressed (brew install pngquant).");

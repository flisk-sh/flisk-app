import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "../src/app.js";

let app, browser, page, saves;
before(async () => {
  app = await startAppServer({ projects: [], probe: async () => ({ state: "supported", lifecycle: true }), dockerCheck: async () => true, claudeDesktopApp: () => null });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
});
beforeEach(async () => {
  saves = [];
  page = await browser.newPage();
  await page.route("**/api/state", async (route) => {
    if (route.request().method() === "PUT") saves.push(route.request().postDataJSON());
    await route.fulfill({ json: { collapsed: [] } });
  });
});
afterEach(async () => page?.close());

async function loadApp(width) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(app.url);
  await page.waitForFunction(() => stateLoaded);
}

// The sidebar is not shown at 640px and below, so its toggle would do nothing visible, and saving its state would surprise the user on a wider window.
for (const width of [640, 390]) {
  test(`the sidebar toggle is not offered at ${width}px`, async () => {
    await loadApp(width);
    assert.equal(await page.locator("#sidebar").isVisible(), false);
    assert.equal(await page.locator("#side-toggle").isVisible(), false);
  });

  for (const modifier of ["Control", "Meta"]) {
    test(`${modifier}+B changes nothing at ${width}px`, async () => {
      await loadApp(width);
      await page.keyboard.press(`${modifier}+b`);
      await page.waitForTimeout(500); // longer than the debounce before state is saved
      assert.deepEqual(saves, []);
      assert.equal(await page.locator(".app").evaluate((element) => element.classList.contains("rail")), false);
      assert.equal(await page.locator("#side-toggle").getAttribute("aria-expanded"), "true");
    });
  }
}

test("the sidebar toggle is still there at 641px", async () => {
  await loadApp(641);
  assert.equal(await page.locator("#sidebar").isVisible(), true);
  assert.equal(await page.locator("#side-toggle").isVisible(), true);
});

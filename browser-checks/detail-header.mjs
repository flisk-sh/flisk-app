import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "../src/app.js";

let app, browser, page;
before(async () => {
  app = await startAppServer({ projects: [], probe: async () => ({ state: "supported", lifecycle: true }), dockerCheck: async () => true, claudeDesktopApp: () => null });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
});
beforeEach(async () => {
  page = await browser.newPage();
  await page.route("**/api/state", (route) => route.fulfill({ json: { collapsed: [] } }));
  await page.route("**/api/projects?*", (route) => route.fulfill({ json: { projects: [
    { id: "a", name: "Alpha", path: "/fixtures/alpha", resources: [{ name: "api", type: "backend", status: "ready" }], stacks: [] },
  ] } }));
});
afterEach(async () => page?.close());

// Below 641px the header is a column, so the title block must not keep the 320px flex-basis it has in the row layout.
for (const width of [390, 600, 640]) {
  test(`project header has no blank gap at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(app.url);
    await page.locator(".project-open:visible").first().click();
    await page.locator(".detail-title").waitFor();
    const { titleHeight, contentHeight, gap } = await page.evaluate(() => {
      const title = document.querySelector(".detail-title");
      const path = title.querySelector(".detail-path").getBoundingClientRect();
      const actions = document.querySelector(".detail-actions").getBoundingClientRect();
      return { titleHeight: title.getBoundingClientRect().height, contentHeight: path.bottom - title.getBoundingClientRect().top, gap: actions.top - path.bottom };
    });
    assert.ok(titleHeight <= contentHeight + 1, `title block is ${titleHeight}px tall for ${contentHeight}px of content`);
    assert.ok(gap < 40, `${gap}px between the path and the action buttons`);
  });
}

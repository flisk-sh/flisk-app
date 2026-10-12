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
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/api/state", (route) => route.fulfill({ json: { collapsed: [] } }));
  // "a" is stopped (Start and Restart are enabled), "b" is running (Stop is enabled).
  await page.route("**/api/projects?*", (route) => route.fulfill({ json: { projects: [
    { id: "a", name: "Alpha", path: "/fixtures/alpha", resources: [], stacks: [], tiltRunning: false },
    { id: "b", name: "Beta", path: "/fixtures/beta", resources: [], stacks: [], tiltRunning: true },
  ] } }));
  await page.goto(app.url);
  await page.locator(".project-row").first().waitFor();
  await page.waitForFunction(() => cliChecked);
});
afterEach(async () => page?.close());

// A focus ring is an outline of at least 2px, or a hard (no blur) shadow spread of at least 2px, as the other controls draw it.
// Transitions are allowed to finish first, so a ring that is still fading in is not mistaken for none.
const ring = (selector) => page.locator(selector).evaluate(async (button) => {
  await Promise.all(button.getAnimations().map((animation) => animation.finished.catch(() => {})));
  const style = getComputedStyle(button);
  const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
  const shadow = [...style.boxShadow.matchAll(/ 0px 0px 0px (\d+(?:\.\d+)?)px(?! inset)/g)].some((match) => parseFloat(match[1]) >= 2);
  return outline || shadow;
});

const buttons = {
  "Start in a project row": '.project-row:nth-child(1) [data-action="start"]',
  "Restart in a project row": '.project-row:nth-child(1) [data-action="restart"]',
  "Stop in a project row": '.project-row:nth-child(2) [data-action="stop"]',
  "New project": '.head-actions [data-action="new-project"]',
  "Refresh": "#refresh",
  // Control: this button already had a ring, which shows the check can tell a ring from none.
  "Build with AI": '.head-actions [data-action="build-with-ai"]',
};

for (const scheme of ["light", "dark"]) {
  for (const [name, selector] of Object.entries(buttons)) {
    test(`${name} shows a focus ring for keyboard focus (${scheme})`, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(0, 0);
      const button = page.locator(selector);
      await button.focus();
      // Move away and back with the keyboard so :focus-visible applies, as it does when tabbing.
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      assert.equal(await button.evaluate((element) => element.matches(":focus-visible")), true);
      assert.equal(await ring(selector), true, `${name} shows no focus ring`);
      await button.evaluate((element) => element.blur());
      assert.equal(await ring(selector), false, `${name} shows a ring while not focused`);
    });
  }
}

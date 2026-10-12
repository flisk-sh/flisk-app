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
// The page re-renders now and then and replaces every button, so this also reports whether the button was still focused when it looked.
const look = (selector) => page.locator(selector).evaluate(async (button) => {
  await Promise.all(button.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  const style = getComputedStyle(button);
  const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
  const shadow = [...style.boxShadow.matchAll(/ 0px 0px 0px (\d+(?:\.\d+)?)px(?! inset)/g)].some((match) => parseFloat(match[1]) >= 2);
  return { ring: outline || shadow, keyboardFocused: button === document.activeElement && button.matches(":focus-visible") };
});

// Tabs onto the button the way a keyboard user would, and retries if a re-render took the focus away before it could be read.
async function ringWhenTabbedTo(selector) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.mouse.move(0, 0);
    await page.locator(selector).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const seen = await look(selector);
    if (seen.keyboardFocused) return seen.ring;
  }
  assert.fail(`could not keep keyboard focus on ${selector}`);
}

const openProject = () => page.locator(".project-open").first().click();
const openNewProjectDialog = async () => {
  await page.locator('.head-actions [data-action="new-project"]').click();
  await page.locator("#form-dialog[open]").waitFor();
};

const buttons = {
  "Start in a project row": { selector: '.project-row:nth-child(1) [data-action="start"]' },
  "Restart in a project row": { selector: '.project-row:nth-child(1) [data-action="restart"]' },
  "Stop in a project row": { selector: '.project-row:nth-child(2) [data-action="stop"]' },
  "New project": { selector: '.head-actions [data-action="new-project"]' },
  "Refresh": { selector: "#refresh" },
  "Start on the project page": { selector: '.detail-actions [data-action="start"]', setup: openProject },
  "Restart on the project page": { selector: '.detail-actions [data-action="restart"]', setup: openProject },
  // Inside a modal, the sidebar is inert, so focus moves to the dialog's name field instead.
  "Create project in the New project dialog": { selector: '#form-dialog [type="submit"]', setup: openNewProjectDialog, elsewhere: '#form-dialog input[name="name"]' },
  "Close in the New project dialog": { selector: "#form-dialog .modal-head [data-close]", setup: openNewProjectDialog, elsewhere: '#form-dialog input[name="name"]' },
  // Control: this button already had a ring, which shows the check can tell a ring from none.
  "Build with AI": { selector: '.head-actions [data-action="build-with-ai"]' },
};

for (const scheme of ["light", "dark"]) {
  for (const [name, { selector, setup, elsewhere = "#search" }] of Object.entries(buttons)) {
    test(`${name} shows a focus ring for keyboard focus (${scheme})`, async () => {
      await page.emulateMedia({ colorScheme: scheme });
      await setup?.();
      assert.equal(await ringWhenTabbedTo(selector), true, `${name} shows no focus ring`);
      // Move focus to the sidebar filter rather than blurring: the app restores focus to the same control after each refresh.
      await page.locator(elsewhere).focus();
      assert.equal((await look(selector)).ring, false, `${name} shows a ring while not focused`);
    });
  }
}

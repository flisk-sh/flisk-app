import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "../src/app.js";

let app;
let browser;
let page;

before(async () => {
  app = await startAppServer({
    projects: [],
    probe: async () => ({ state: "supported", lifecycle: true, version: "1.3.145" }),
    dockerCheck: async () => true,
    claudeDesktopApp: () => null,
  });
  browser = await chromium.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
});

beforeEach(async () => {
  await page.goto(app.url);
  await page.waitForFunction(() => typeof openForm === "function");
});

test("an empty name marks the field that failed validation", async () => {
  await page.locator("#new-project-nav").click();
  await page.locator("#form-dialog[open]").waitFor();
  await page.locator('#form-dialog button[type="submit"]').click();
  await page.locator("#form-dialog .form-error:not([hidden])").waitFor();
  assert.equal(await page.locator("#f-name").getAttribute("aria-invalid"), "true");
});

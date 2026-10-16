import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { startAppServer } from "../src/app.js";

let app;
let browser;
let page;
let project;
let empty;
let scratch;

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "tdk-app-open-"));
  project = join(scratch, "demo-shop");
  empty = join(scratch, "not-a-project");
  mkdirSync(join(project, ".tdk"), { recursive: true });
  mkdirSync(empty);
  writeFileSync(join(project, ".tdk", "project.json"), JSON.stringify({ project: { name: "demo-shop" } }));
  app = await startAppServer({
    projects: [],
    probe: async () => ({ state: "supported", lifecycle: true, version: "1.3.145" }),
    dockerCheck: async () => true,
    claudeDesktopApp: () => null,
    statePath: join(scratch, "state.json"),
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(app.url);
  await page.waitForFunction(() => typeof openForm === "function");
});

after(async () => {
  await browser?.close();
  if (app) await new Promise((resolve) => app.server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
});

async function submitPath(path) {
  await page.locator("#open-project-nav").click();
  await page.getByRole("dialog", { name: "Open project", exact: true }).waitFor();
  await page.fill('input[name="path"]', path);
  await page.locator('#form-dialog form [type="submit"]').click();
}

test("a folder without .tdk/project.json is refused and nothing is added", async () => {
  await submitPath(empty);
  await page.locator("#form-dialog .form-error:not([hidden])").waitFor();
  assert.match(await page.locator("#form-dialog .form-error").innerText(), /could not complete|project\.json/i);
  assert.equal((await (await fetch(`${new URL(app.url).origin}/api/projects`, { headers: { "x-tdk-token": app.token } })).json()).projects.length, 0);
  await page.locator("#form-dialog [data-close]").first().click();
});

test("Open project adds an existing project, which then shows in the list", async () => {
  await submitPath(project);
  await page.locator("#form-dialog .form-output").waitFor();
  assert.match(await page.locator("#form-dialog .form-output").innerText(), /Added demo-shop/);
  await page.locator('#form-dialog form [type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector("#form-dialog").open);
  assert.ok(await page.getByText("demo-shop").first().isVisible());
});

test("opening the same project again says it is already listed", async () => {
  await submitPath(project);
  await page.locator("#form-dialog .form-output").waitFor();
  assert.match(await page.locator("#form-dialog .form-output").innerText(), /already in the list/);
  await page.locator("#form-dialog [data-close]").first().click();
});

test("the header Open project button opens the same dialog", async () => {
  await page.locator("#overview-nav").click();
  await page.locator('.page-head [data-action="open-existing-project"]').click();
  assert.equal(await page.getByRole("dialog", { name: "Open project", exact: true }).count(), 1);
  await page.locator("#form-dialog [data-close]").first().click();
});

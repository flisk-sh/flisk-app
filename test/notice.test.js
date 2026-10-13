import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Run the actual notice state machine with a small DOM adapter. Browser checks
// cover the complete page; this keeps the timeout and ARIA contract deterministic.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("let activeNotice = null;");
const end = source.indexOf("\nfunction applyBusy", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const noticeSource = source.slice(start, end);

class Element {
  constructor() {
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    const values = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => values.add(name)),
      remove: (...names) => names.forEach((name) => values.delete(name)),
      toggle: (name, force) => {
        if (force === undefined ? !values.has(name) : force) values.add(name);
        else values.delete(name);
      },
      has: (name) => values.has(name),
    };
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
}

function setup() {
  const notice = new Element();
  const timers = [];
  const document = {
    querySelector(selector) {
      assert.equal(selector, "#notice");
      return notice;
    },
    createElement() { return new Element(); },
  };
  const context = {
    document,
    selectedProjectId: null,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
  };
  const api = runInNewContext(`${noticeSource}\n({ showNotice, dismissNotice })`, context);
  return { ...api, notice, timers };
}

test("error notices stay visible and announce themselves as alerts", () => {
  const { showNotice, notice, timers } = setup();
  showNotice("Could not refresh projects", true);

  assert.equal(timers.length, 0);
  assert.equal(notice.attributes.get("role"), "alert");
  assert.equal(notice.children[0].textContent, "Could not refresh projects");
  assert.equal(notice.classList.has("show"), true);
  assert.equal(notice.classList.has("error"), true);
});

test("success notices retain their nine-second auto-dismiss", () => {
  const { showNotice, notice, timers } = setup();
  showNotice("Projects refreshed");

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 9000);
  assert.equal(notice.attributes.get("role"), "status");

  timers[0].callback();
  assert.equal(notice.classList.has("show"), false);
});

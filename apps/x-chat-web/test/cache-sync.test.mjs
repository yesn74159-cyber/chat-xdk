import assert from "node:assert/strict";
import test from "node:test";
import { createCacheSync } from "../public/cache-sync.mjs";

class FakeBroadcastChannel {
  static instances = [];
  constructor(name) {
    this.name = name;
    this.listeners = new Set();
    this.closed = false;
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data) {
    if (this.closed) throw new Error("channel closed");
    for (const other of FakeBroadcastChannel.instances) {
      if (other !== this && other.name === this.name && !other.closed) {
        for (const listener of other.listeners) listener({ data });
      }
    }
  }
  addEventListener(type, listener) {
    if (type === "message") this.listeners.add(listener);
  }
  removeEventListener(type, listener) {
    if (type === "message") this.listeners.delete(listener);
  }
  close() {
    this.closed = true;
  }
}

function withFakeChannel(run) {
  const previous = Reflect.get(globalThis, "BroadcastChannel");
  Reflect.set(globalThis, "BroadcastChannel", FakeBroadcastChannel);
  FakeBroadcastChannel.instances = [];
  try {
    return run();
  } finally {
    Reflect.set(globalThis, "BroadcastChannel", previous);
  }
}

test("a cache write notifies other tabs but never the writer itself", () => {
  withFakeChannel(() => {
    const writer = createCacheSync("test-channel");
    const otherTab = createCacheSync("test-channel");
    let writerNotified = 0;
    let otherNotified = 0;
    writer.onChange(() => (writerNotified += 1));
    otherTab.onChange(() => (otherNotified += 1));

    writer.announce();

    assert.equal(writerNotified, 0);
    assert.equal(otherNotified, 1);
  });
});

test("unsubscribe and close stop further notices without throwing", () => {
  withFakeChannel(() => {
    const writer = createCacheSync("test-channel");
    const otherTab = createCacheSync("test-channel");
    let notified = 0;
    const unsubscribe = otherTab.onChange(() => (notified += 1));

    writer.announce();
    unsubscribe();
    writer.announce();
    assert.equal(notified, 1);

    otherTab.close();
    writer.announce();
    writer.close();
    writer.close();
    assert.equal(notified, 1);
  });
});

test("unrelated messages and other channels are ignored", () => {
  withFakeChannel(() => {
    const writer = createCacheSync("test-channel");
    const outsider = createCacheSync("another-channel");
    const tab = createCacheSync("test-channel");
    let notified = 0;
    tab.onChange(() => (notified += 1));

    writer.announce();
    outsider.announce();
    assert.equal(notified, 1);
  });
});

test("without BroadcastChannel the sync degrades to a silent no-op", () => {
  const previous = Reflect.get(globalThis, "BroadcastChannel");
  Reflect.deleteProperty(globalThis, "BroadcastChannel");
  try {
    const sync = createCacheSync();
    assert.equal(sync.supported, false);
    sync.announce();
    const unsubscribe = sync.onChange(() => assert.fail("callback must not run"));
    unsubscribe();
    sync.close();
  } finally {
    Reflect.set(globalThis, "BroadcastChannel", previous);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { appendLinkedText, linkSegments } from "../public/links.mjs";

test("link segments preserve non-URL content as text", () => {
  assert.deepEqual(linkSegments('Open https://example.com and <img src=x onerror="bad">'), [
    { type: "text", value: "Open " },
    { type: "link", value: "https://example.com" },
    { type: "text", value: ' and <img src=x onerror="bad">' },
  ]);
  assert.deepEqual(linkSegments("no links"), [{ type: "text", value: "no links" }]);
});

test("link rendering uses DOM nodes and safe new-tab attributes", () => {
  const container = {
    children: [],
    append(node) {
      this.children.push(node);
    },
  };
  const document = {
    createTextNode(value) {
      return { kind: "text", value };
    },
    createElement(tagName) {
      return { kind: "element", tagName };
    },
  };
  appendLinkedText(document, container, 'Open https://example.com <img src=x onerror="bad">');
  assert.deepEqual(container.children, [
    { kind: "text", value: "Open " },
    {
      kind: "element",
      tagName: "a",
      href: "https://example.com",
      textContent: "https://example.com",
      target: "_blank",
      rel: "noopener noreferrer",
    },
    { kind: "text", value: ' <img src=x onerror="bad">' },
  ]);
});

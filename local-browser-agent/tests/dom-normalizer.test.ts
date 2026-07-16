import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDomSnapshot } from "../apps/extension/src/dom-normalizer.js";

const strings = ["HTML", "BODY", "BUTTON", "DIV", "id", "submit", "role", "button", "Click me", "https://example.test/", "block", "16px"];
const snapshot = {
  strings,
  documents: [{
    documentURL: 9,
    baseURL: 9,
    nodes: {
      nodeName: [0, 1, 3, 2],
      nodeValue: [-1, -1, -1, 8],
      parentIndex: [-1, 0, 1, 2],
      attributes: [[], [], [4, 5], [6, 7]],
      backendNodeId: [1, 2, 3, 4]
    },
    layout: {
      nodeIndex: [0, 1, 2, 3],
      bounds: [[0, 0, 800, 600], [0, 0, 800, 600], [10, 10, 100, 20], [20, 20, 80, 30]],
      styles: [[10, 11], [10, 11], [10, 11], [10, 11]],
      paintOrders: [0, 1, 2, 3]
    }
  }]
};

test("interactive mode keeps structural regions and controls", () => {
  const result = normalizeDomSnapshot(snapshot, { mode: "interactive", maxNodes: 100, styleNames: ["display", "font-size"] }) as any;
  const nodes = result.documents[0].nodes;
  assert.equal(nodes.some((node: any) => node.tag === "BUTTON"), true);
  assert.equal(nodes.some((node: any) => node.tag === "DIV"), false);
  assert.equal(nodes.find((node: any) => node.tag === "BUTTON").interactive, true);
  assert.equal(nodes.find((node: any) => node.tag === "BUTTON").computedStyle["font-size"], "16px");
  assert.equal(nodes.find((node: any) => node.tag === "BUTTON").paintOrder, 3);
});

test("normalizer enforces node limits", () => {
  const result = normalizeDomSnapshot(snapshot, { mode: "full", maxNodes: 2 }) as any;
  assert.equal(result.returnedNodes, 2);
  assert.equal(result.truncated, true);
});

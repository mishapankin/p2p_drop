import { test } from "node:test";
import assert from "node:assert/strict";
import { Transfer, MAX_FILE_SIZE, type TransferState } from "./transfer.ts";

function pair() {
  let leftState: TransferState = { phase: "idle", progress: 0 };
  let rightState: TransferState = { phase: "idle", progress: 0 };
  let count = 0;
  const left = new Transfer(m => { count++; queueMicrotask(() => right.receive(m)); }, s => { leftState = s; });
  const right = new Transfer(m => queueMicrotask(() => left.receive(m)), s => { rightState = s; });
  return { left, right, get leftState() { return leftState; }, get rightState() { return rightState; }, get count() { return count; }, close() { left.dispose(); right.dispose(); } };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for transfer state");
}

test("multi-chunk binary file is exact, waits for acceptance, then sends in reverse", async () => {
  const p = pair();
  try {
    const bytes = new Uint8Array(256_013).map((_, i) => i % 251);
    p.left.offer(new File([bytes], "photo.bin"));
    await until(() => p.rightState.phase === "incoming");
    assert.equal(p.count, 1);
    assert.equal(p.leftState.phase, "offering");
    p.right.accept();
    await until(() => p.leftState.phase === "sent");
    assert.equal(p.rightState.name, "photo.bin");
    assert.deepEqual(new Uint8Array(await p.rightState.blob!.arrayBuffer()), bytes);
    assert.equal(p.left.busy, false);
    p.right.offer(new File(["backwards"], "return.txt"));
    await until(() => p.leftState.phase === "incoming");
    p.left.accept();
    await until(() => p.rightState.phase === "sent");
    assert.equal(await p.leftState.blob!.text(), "backwards");
  } finally { p.close(); }
});

test("zero-byte file completes", async () => {
  const p = pair();
  try {
    p.left.offer(new File([], "empty.txt"));
    await until(() => p.rightState.phase === "incoming");
    p.right.accept();
    await until(() => p.leftState.phase === "sent");
    assert.equal(p.rightState.blob!.size, 0);
  } finally { p.close(); }
});

test("decline, simultaneous offers, and disconnect release the session", async () => {
  const p = pair();
  try {
    p.left.offer(new File(["a"], "a"));
    await until(() => p.rightState.phase === "incoming");
    p.right.cancel();
    await until(() => !p.left.busy);
    p.left.offer(new File(["a"], "a"));
    p.right.offer(new File(["b"], "b"));
    await until(() => !p.left.busy && !p.right.busy);
    p.left.offer(new File(["c"], "c"));
    await until(() => p.rightState.phase === "incoming");
    p.right.accept();
    p.left.disconnect();
    p.right.disconnect();
    assert.equal(p.leftState.phase, "error");
    assert.equal(p.right.busy, false);
  } finally { p.close(); }
});

test("rejects oversized offers and invalid chunk offsets", () => {
  let state: TransferState | undefined;
  const sent: unknown[] = [];
  const t = new Transfer(m => sent.push(m), s => { state = s; });
  try {
    t.receive({ type: "offer", id: "too-big", name: "big", size: MAX_FILE_SIZE + 1 });
    assert.equal(t.busy, false);
    assert.deepEqual(sent[0], { type: "cancel", id: "too-big" });
    t.receive({ type: "offer", id: "valid", name: "file", size: 2 });
    t.accept();
    t.receive({ type: "chunk", id: "valid", offset: 1, data: new ArrayBuffer(2) });
    assert.equal(state?.phase, "error");
    assert.equal(t.busy, false);
  } finally { t.dispose(); }
});

test("incomplete files never produce a download", () => {
  let state: TransferState | undefined;
  const t = new Transfer(() => {}, s => { state = s; });
  try {
    t.receive({ type: "offer", id: "x", name: "file", size: 20 });
    t.accept();
    t.receive({ type: "end", id: "x" });
    assert.equal(state?.phase, "error");
    assert.equal(state?.blob, undefined);
  } finally { t.dispose(); }
});

test("stalled accepted transfer times out", async () => {
  let state: TransferState | undefined;
  const t = new Transfer(() => {}, s => { state = s; }, 5);
  try {
    t.receive({ type: "offer", id: "x", name: "file", size: 1 });
    t.accept();
    await until(() => !t.busy);
    assert.match(state?.message ?? "", /timed out/);
  } finally { t.dispose(); }
});

test("accepts PeerJS reassembled typed-array chunks without surrounding bytes", async () => {
  let state: TransferState | undefined;
  const t = new Transfer(() => {}, s => { state = s; });
  try {
    t.receive({ type: "offer", id: "typed", name: "file", size: 3 });
    t.accept();
    t.receive({ type: "chunk", id: "typed", offset: 0, data: new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4) });
    t.receive({ type: "end", id: "typed" });
    assert.equal(state?.phase, "received");
    assert.deepEqual(new Uint8Array(await state!.blob!.arrayBuffer()), new Uint8Array([1, 2, 3]));
  } finally { t.dispose(); }
});

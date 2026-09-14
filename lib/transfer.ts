export const MAX_FILE_SIZE = 100 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;

type Info = { id: string; name: string; size: number };
export type TransferState = {
  phase: "idle" | "offering" | "incoming" | "sending" | "receiving" | "sent" | "received" | "error";
  name?: string;
  size?: number;
  progress: number;
  message?: string;
  blob?: Blob;
};
type Active = Info & { direction: "send" | "receive"; accepted: boolean; offset: number; pending: number; file?: File; chunks: ArrayBuffer[] };

/** One acknowledged chunk in flight bounds the sender's queue, even on slow links. */
export class Transfer {
  private active?: Active;
  private timer?: ReturnType<typeof setTimeout>;
  private send: (message: unknown) => void;
  private update: (state: TransferState) => void;
  private timeoutMs: number;

  constructor(send: (message: unknown) => void, update: (state: TransferState) => void, timeoutMs = 30_000) {
    this.send = send;
    this.update = update;
    this.timeoutMs = timeoutMs;
  }

  get busy() { return !!this.active; }

  private publish(phase: TransferState["phase"], extra: Partial<TransferState> = {}) {
    const a = this.active;
    this.update({ phase, name: a?.name, size: a?.size, progress: a ? (a.size ? a.offset / a.size : 0) : 0, ...extra });
  }

  private watch(offer = false) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.cancel("Transfer timed out. Try again."), offer ? 120_000 : this.timeoutMs);
  }

  private transmit(message: unknown) {
    try { this.send(message); return true; }
    catch { this.disconnect(); return false; }
  }

  offer(file: File) {
    if (this.busy) return;
    if (file.size > MAX_FILE_SIZE) {
      this.update({ phase: "error", progress: 0, message: "Choose a file under 100 MiB." });
      return;
    }
    this.active = { id: crypto.randomUUID(), name: file.name, size: file.size, file, direction: "send", accepted: false, offset: 0, pending: 0, chunks: [] };
    this.publish("offering");
    this.watch(true);
    const { id, name, size } = this.active;
    this.transmit({ type: "offer", id, name, size });
  }

  accept() {
    const a = this.active;
    if (!a || a.direction !== "receive" || a.accepted) return;
    a.accepted = true;
    this.publish("receiving");
    this.watch();
    this.transmit({ type: "accept", id: a.id });
  }

  cancel(message = "Transfer cancelled.") {
    const id = this.active?.id;
    this.clear();
    this.update({ phase: "error", progress: 0, message });
    if (id) this.transmit({ type: "cancel", id });
  }

  disconnect() {
    const wasBusy = this.busy;
    this.clear();
    if (wasBusy) this.update({ phase: "error", progress: 0, message: "Connection lost. Send the file again." });
  }

  dispose() { this.clear(); }
  private clear() { clearTimeout(this.timer); this.active = undefined; }

  private async next(a: Active) {
    if (this.active !== a) return;
    this.watch();
    if (a.offset === a.size) {
      this.transmit({ type: "end", id: a.id });
      return;
    }
    try {
      const data = await a.file!.slice(a.offset, a.offset + CHUNK_SIZE).arrayBuffer();
      if (this.active !== a) return;
      a.pending = a.offset + data.byteLength;
      this.transmit({ type: "chunk", id: a.id, offset: a.offset, data });
    } catch { if (this.active === a) this.cancel("Could not read this file."); }
  }

  receive(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length > 64) return;
    if (m.type === "offer") {
      if (this.busy || typeof m.name !== "string" || !m.name.length || m.name.length > 1024 || typeof m.size !== "number" || !Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_FILE_SIZE) {
        this.transmit({ type: "cancel", id: m.id });
        return;
      }
      this.active = { id: m.id, name: m.name, size: m.size, direction: "receive", accepted: false, offset: 0, pending: 0, chunks: [] };
      this.publish("incoming");
      this.watch(true);
      return;
    }
    const a = this.active;
    if (!a || m.id !== a.id) return;
    if (m.type === "cancel") {
      this.clear();
      this.update({ phase: "error", progress: 0, message: "Transfer declined or cancelled." });
    } else if (m.type === "accept" && a.direction === "send" && !a.accepted) {
      a.accepted = true;
      this.publish("sending");
      void this.next(a);
    } else if (m.type === "ack" && a.direction === "send" && a.accepted && m.offset === a.pending && a.pending > a.offset) {
      a.offset = a.pending;
      this.publish("sending");
      void this.next(a);
    } else if (m.type === "chunk" && a.direction === "receive" && a.accepted) {
      const data = m.data instanceof ArrayBuffer ? m.data : ArrayBuffer.isView(m.data) ? new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength).slice().buffer : null;
      if (!data || data.byteLength === 0 || data.byteLength > CHUNK_SIZE || m.offset !== a.offset || a.offset + data.byteLength > a.size) {
        this.cancel("Invalid transfer. Try again.");
        return;
      }
      a.chunks.push(data);
      a.offset += data.byteLength;
      this.publish("receiving");
      this.watch();
      this.transmit({ type: "ack", id: a.id, offset: a.offset });
    } else if (m.type === "end" && a.direction === "receive" && a.accepted) {
      if (a.offset !== a.size) { this.cancel("Incomplete file. Try again."); return; }
      // Force downloads, rather than rendering potentially active file content.
      const blob = new Blob(a.chunks, { type: "application/octet-stream" });
      this.publish("received", { blob, progress: 1 });
      this.clear();
      this.transmit({ type: "done", id: a.id });
    } else if (m.type === "done" && a.direction === "send" && a.accepted && a.offset === a.size) {
      this.publish("sent", { progress: 1 });
      this.clear();
    }
  }
}

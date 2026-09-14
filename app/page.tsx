"use client";

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { DataConnection, Peer } from "peerjs";
import { MAX_FILE_SIZE, Transfer, type TransferState } from "../lib/transfer";

const EMPTY: TransferState = { phase: "idle", progress: 0 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
function Arrow({ down = false }: { down?: boolean }) {
  return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" style={down ? { transform: "rotate(180deg)" } : undefined}><path d="M12 18V5m-5 5 5-5 5 5M5 19h14" /></svg>;
}

export default function Home() {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("Starting");
  const [invite, setInvite] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [file, setFile] = useState<File>();
  const [transfer, setTransfer] = useState<TransferState>(EMPTY);
  const [download, setDownload] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const engine = useRef<Transfer | null>(null);
  const objectUrl = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const connected = status === "Connected";
  const busy = ["offering", "incoming", "sending", "receiving"].includes(transfer.phase);

  useEffect(() => {
    let stopped = false;
    let peer: Peer | undefined;
    let connection: DataConnection | undefined;
    let deadline: ReturnType<typeof setTimeout>;
    const revoke = () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = "";
    };
    const fail = (message: string) => {
      if (stopped) return;
      clearTimeout(deadline);
      engine.current?.disconnect();
      stopped = true;
      setStatus("Disconnected");
      setConnectionError(message);
      setInvite("");
      peer?.destroy();
    };
    const update = (state: TransferState) => {
      if (stopped) return;
      if (state.phase === "offering" || state.phase === "incoming" || state.phase === "received") {
        revoke();
        setDownload("");
      }
      if (state.blob) {
        objectUrl.current = URL.createObjectURL(state.blob);
        setDownload(objectUrl.current);
      }
      if (state.phase === "sent") setFile(undefined);
      setTransfer(state);
    };
    const bind = (conn: DataConnection) => {
      if (connection) { conn.on("open", () => conn.close()); return; }
      connection = conn;
      clearTimeout(deadline);
      deadline = setTimeout(() => fail("Could not connect. Try another network."), 30_000);
      conn.on("open", () => {
        if (stopped) { conn.close(); return; }
        clearTimeout(deadline);
        engine.current = new Transfer(message => {
          if (!conn.open) throw new Error("Disconnected");
          conn.send(message);
        }, update);
        setStatus("Connected");
        setInvite("");
        setNotice("");
      });
      conn.on("data", data => { if (!stopped) engine.current?.receive(data); });
      conn.on("close", () => fail("The other device disconnected or the session is full."));
      conn.on("error", () => fail("Connection failed. Try again or use another network."));
    };
    void import("peerjs").then(({ Peer }) => {
      if (stopped) return;
      setStatus("Starting");
      setConnectionError("");
      setInvite("");
      setTransfer(EMPTY);
      setDownload("");
      setNotice("");
      setCopied(false);
      const target = window.location.hash.slice(1);
      if (target && !UUID.test(target)) { fail("This invitation is invalid."); return; }
      setStatus(target ? "Connecting" : "Starting");
      const id = crypto.randomUUID();
      peer = new Peer(id, {
        debug: 0,
        config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
      });
      deadline = setTimeout(() => fail("Connection service unavailable. Try again."), 30_000);
      peer.on("open", () => {
        if (stopped) return;
        clearTimeout(deadline);
        if (target) {
          bind(peer!.connect(target, { reliable: true, serialization: "binary" }));
        } else {
          setStatus("Waiting");
          const url = new URL(window.location.href);
          url.search = "";
          url.hash = id;
          setInvite(url.href);
        }
      });
      peer.on("connection", conn => {
        if (target || stopped) { conn.on("open", () => conn.close()); return; }
        bind(conn);
      });
      peer.on("error", error => fail(error.type === "peer-unavailable" ? "This session is unavailable. Scan a new QR code." : "Connection failed. Try again or use another network."));
      peer.on("disconnected", () => {
        if (!connection?.open) fail("Connection service disconnected. Try again.");
      });
    }).catch(() => fail("Could not start. Reload and try again."));
    const hashChanged = () => setAttempt(n => n + 1);
    window.addEventListener("hashchange", hashChanged);
    return () => {
      stopped = true;
      clearTimeout(deadline);
      window.removeEventListener("hashchange", hashChanged);
      engine.current?.dispose();
      engine.current = null;
      peer?.destroy();
      revoke();
    };
  }, [attempt]);

  function select(files: FileList | null) {
    if (busy || !files?.length) return;
    if (files.length !== 1) { setNotice("Choose one file at a time."); return; }
    if (files[0].size > MAX_FILE_SIZE) { setNotice("Choose a file under 100 MiB."); return; }
    setFile(files[0]);
    setNotice("");
    if (["sent", "error"].includes(transfer.phase)) setTransfer(EMPTY);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(invite); setCopied(true); }
    catch { setNotice("Copy the invitation below."); }
  }
  const phaseLabel = { idle: "", offering: "Waiting for acceptance", incoming: "Incoming file", sending: "Sending", receiving: "Receiving", sent: "Sent", received: "Received", error: "" }[transfer.phase];

  return (
    <main>
      <header><h1>Drop<span className="period">.</span></h1><span className="status" role="status"><i className={connected ? "online" : ""} />{status}</span></header>
      {invite && <section className="pairing" aria-label="Pair a device">
        <QRCodeSVG value={invite} size={184} level="M" marginSize={4} title="Scan to connect" />
        <button className="text-button" onClick={copy}>{copied ? "Copied" : "Copy link"}<span aria-hidden="true">↗</span></button>
        {notice === "Copy the invitation below." && <input aria-label="Invitation link" className="invite-input" readOnly value={invite} onFocus={event => event.target.select()} />}
      </section>}
      {connectionError && <section className="connection-error"><p role="alert">{connectionError}</p><div className="actions"><button onClick={() => setAttempt(n => n + 1)}>Retry</button><button className="text-button" onClick={() => { window.history.replaceState(null, "", window.location.pathname); setAttempt(n => n + 1); }}>New session</button></div></section>}
      <section className="files" aria-label="File transfer">
        <button className={`dropzone ${dragging ? "dragging" : ""}`} disabled={busy} onClick={() => input.current?.click()}
          onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); select(event.dataTransfer.files); }}>
          <Arrow /><span>{dragging ? "Drop here" : "Drop a file"}</span><span className="browse">or choose a file</span>
        </button>
        <input ref={input} className="visually-hidden" type="file" aria-label="Choose a file" tabIndex={-1} disabled={busy} onChange={event => { select(event.target.files); event.target.value = ""; }} />
        {file && !busy && <div className="file-row"><div className="file-info"><span className="filename">{file.name}</span><span className="file-size">{size(file.size)}</span></div><button className="text-button remove" aria-label="Remove file" onClick={() => setFile(undefined)}>×</button><button disabled={!connected} onClick={() => { setNotice(""); engine.current?.offer(file); }}>Send <span aria-hidden="true">↑</span></button></div>}
        {phaseLabel && <div className="transfer">
          <div className="transfer-heading"><span>{phaseLabel}</span>{["sending", "receiving"].includes(transfer.phase) && <span className="percentage">{Math.floor(transfer.progress * 100)}%</span>}</div>
          <div className="file-info"><span className="filename">{transfer.name}</span><span className="file-size">{size(transfer.size ?? 0)}</span></div>
          {["sending", "receiving"].includes(transfer.phase) && <progress max={1} value={transfer.progress} aria-label="Transfer progress" />}
          <div className="actions">
            {transfer.phase === "incoming" ? <><button onClick={() => engine.current?.accept()}>Accept <span aria-hidden="true">↓</span></button><button className="text-button" onClick={() => engine.current?.cancel("Transfer declined.")}>Decline</button></> : busy ? <button className="text-button" onClick={() => engine.current?.cancel()}>Cancel</button> : null}
            {transfer.phase === "received" && download && <a className="button" href={download} download={transfer.name}>Save <span aria-hidden="true">↓</span></a>}
          </div>
        </div>}
        {(notice || transfer.message) && <p className="notice" role="alert">{notice || transfer.message}</p>}
      </section>
      <footer><span>1 file · 100 MiB max</span>{connected && <span>Keep both tabs open</span>}</footer>
    </main>
  );
}

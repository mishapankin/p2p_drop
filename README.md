# Drop

A static, two-device file transfer app for https://mishapankin.github.io/p2p_drop/.

Open the app on one device, scan its QR code on another (or copy the invitation link), and keep both tabs open. Either device can choose a file and send it. The receiver accepts the transfer, then taps Save.

## Development

Requires Node.js 24+ and pnpm (the version is pinned in package.json).

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000/p2p_drop/. For testing with a phone, use the deployed HTTPS site; clipboard and UUID APIs require a secure context.

```sh
pnpm lint
pnpm test
pnpm build
```

The complete static site is generated in `out/`. No Next.js server is needed in production. Serve the output at `/p2p_drop/`, matching `basePath` in `next.config.ts`.

## GitHub Pages

The included `.github/workflows/pages.yml` builds and deploys pushes to `main`, or can be run manually from Actions. In the `mishapankin/p2p_drop` repository, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Push the project to `main` to deploy.

Invitations use `https://mishapankin.github.io/p2p_drop/#<uuid>` so GitHub Pages can serve every invitation from the same static page. The host keeps its base URL; refreshing it creates a new invitation. Invitations require the host tab to remain open.

## Transfer behavior

- PeerJS Cloud provides external signaling; Google STUN helps discover direct routes. Internet access is needed for pairing.
- File bytes use an encrypted WebRTC data channel between the browsers. No file storage or application backend is involved.
- No TURN relay is configured. Some VPNs, corporate networks, or restrictive NATs cannot connect; try a different network.
- One connected pair, one file at a time, in either direction. Additional devices are refused.
- Files are capped at 100 MiB. The receiver holds the file in memory until it is saved or replaced by another transfer. This is not a guarantee that every mobile device can handle the maximum.
- Explicit acceptance is required before sending bytes. 64 KiB chunks are acknowledged individually to bound outgoing buffering. The receiver checks chunk offsets and total length before offering Save.
- A 30-second stall, cancellation, or disconnect aborts the transfer. Acceptance expires after two minutes. Interrupted transfers must restart; there is no background transfer or resume.
- Keep the invitation private: anyone holding it can attempt to join the session. There are no accounts or persistent device identities.

`lib/transfer.test.ts` tests the transport-independent protocol, including exact binary contents in both directions, empty files, declines, simultaneous offers, disconnects, malformed data, and timeouts. Real WebRTC connectivity depends on the devices and network.

# Stable Transfer Speed Design

## Goal

Improve transfer throughput while keeping large-file reliability, resume behavior, cancellation, and checksum validation intact.

## Scope

This pass focuses on the browser transfer loop:

- Increase P2P and relay chunk metadata from 64 KB to 256 KB.
- Keep IndexedDB chunk persistence for recoverability.
- Batch incoming session metadata writes so every chunk does not rewrite `completedChunks`.
- Replace DataChannel buffered-amount polling with event-driven low-buffer waiting, while retaining a timeout fallback.
- Keep relay size limits and base64 relay transport unchanged for stability.

## Non-Goals

- No server-side binary WebSocket relay protocol change.
- No removal of SHA-256 validation.
- No memory-only large-file receive path.
- No change to the user-facing transfer flow.

## Verification

Add core tests for:

- transfer requests advertise 256 KB chunks;
- incoming chunks persist data immediately but defer session metadata until explicit flush.

Run:

- `npm run test:core`
- `npm run test:layout`
- `git diff --check`

# Stable Transfer Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve browser file-transfer throughput while preserving large-file stability and resume support.

**Architecture:** Keep the existing `TransferApp` structure. Tune chunk sizing, make incoming session metadata persistence batched, and use event-driven DataChannel backpressure without changing the server relay protocol.

**Tech Stack:** Browser JavaScript modules, IndexedDB, WebRTC DataChannel, Node `node:test`.

---

### Task 1: Core Regression Tests

**Files:**
- Modify: `scripts/Test-TransferCancellation.mjs`

- [ ] Add a test that starts a transfer request with one selected file and verifies the stored outgoing file metadata has `chunk_size` equal to `256 * 1024`.
- [ ] Add a test that stores two incoming chunks, verifies both chunk payloads are persisted immediately, verifies session metadata is not rewritten per chunk, then calls `flushIncomingChunkState()` and verifies both completed chunk indexes are saved.
- [ ] Run `npm run test:core`; expected failure before implementation.

### Task 2: Stable Transfer Loop Changes

**Files:**
- Modify: `static/core.js`

- [ ] Change `CHUNK_SIZE` from `64 * 1024` to `256 * 1024`.
- [ ] Add incoming metadata flush constants and state fields for dirty count / last flush time.
- [ ] In `storeIncomingChunk()`, keep `putChunk()` per chunk but defer `updateSessionRecord()` until batch threshold, elapsed interval, or final flush.
- [ ] Update `waitForBufferedAmount()` to prefer `bufferedamountlow` and `bufferedAmountLowThreshold`, with timeout polling as fallback.
- [ ] Run `npm run test:core`; expected pass.

### Task 3: Full Verification

**Files:**
- Existing test files only.

- [ ] Run `npm run test:layout`; expected pass.
- [ ] Run `git diff --check`; expected no whitespace errors.
- [ ] Summarize touched files and any residual risk.

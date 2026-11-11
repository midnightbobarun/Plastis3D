// tests/node/announcer.test.ts — shared live-region announcer store
// (Tier 2, Phase 0 0-B).
//
// Covers src/state/announcer.ts: the cached-snapshot contract (same
// reference while unchanged — the PR5 React 19 loop guard), identical
// messages re-announcing via the seq, and the cross-surface dedup:
// each (scene, revision) announces once even when both surfaces fire
// for the same broadcast. The broadcast-wiring harness test belongs
// to G-06 (Phase 4).
import { describe, expect, it } from "vitest";
import {
  announce,
  announceRevision,
  getAnnouncerSnapshot,
  subscribeAnnouncer,
} from "../../src/state/announcer";

describe("announcer store", () => {
  it("returns a stable snapshot reference while unchanged", () => {
    const first = getAnnouncerSnapshot();
    const second = getAnnouncerSnapshot();
    expect(second).toBe(first);
  });

  it("announce changes the snapshot and notifies subscribers", () => {
    const before = getAnnouncerSnapshot();
    let notified = 0;
    const unsubscribe = subscribeAnnouncer(() => {
      notified += 1;
    });
    try {
      announce("Hello from the test.");
      const after = getAnnouncerSnapshot();
      expect(after).not.toBe(before);
      expect(after.message).toBe("Hello from the test.");
      expect(after.seq).toBe(before.seq + 1);
      expect(notified).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  it("an identical message still re-announces (seq bumps)", () => {
    announce("Same words, twice.");
    const first = getAnnouncerSnapshot();
    announce("Same words, twice.");
    const second = getAnnouncerSnapshot();
    expect(second).not.toBe(first);
    expect(second.message).toBe("Same words, twice.");
    expect(second.seq).toBe(first.seq + 1);
  });

  it("announceRevision dedups the same (scene, revision) across surfaces", () => {
    announceRevision("scene-dedup-a", 7);
    const first = getAnnouncerSnapshot();
    expect(first.message).toBe("Scene updated to revision 7.");
    // The second surface fires for the same broadcast: no re-announce.
    announceRevision("scene-dedup-a", 7);
    const second = getAnnouncerSnapshot();
    expect(second).toBe(first);
  });

  it("announceRevision announces a new revision and a different scene", () => {
    announceRevision("scene-dedup-b", 3);
    const first = getAnnouncerSnapshot();
    announceRevision("scene-dedup-b", 4);
    const second = getAnnouncerSnapshot();
    expect(second).not.toBe(first);
    expect(second.message).toBe("Scene updated to revision 4.");
    announceRevision("scene-dedup-c", 4);
    const third = getAnnouncerSnapshot();
    expect(third).not.toBe(second);
    expect(third.message).toBe("Scene updated to revision 4.");
  });
});

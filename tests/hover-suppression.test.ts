import { describe, expect, it } from 'vitest';
import { shouldShowHoleHover } from '../src/app/tools/tools';

// Baseline: nothing special going on → show the hover ring.
const BASE = {
  gestureKind: undefined as Parameters<typeof shouldShowHoleHover>[0]['gestureKind'],
  gesturePanActive: false,
  spaceHeld: false,
  middleDown: false,
  viewFingers: false,
  isDragging: false,
};

describe('shouldShowHoleHover', () => {
  it('shows hover when nothing special is happening', () => {
    expect(shouldShowHoleHover(BASE)).toBe(true);
  });

  // ---- cases that SUPPRESS the hover ----

  it('suppresses when pan gesture is active', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'pan', gesturePanActive: true })).toBe(false);
  });

  it('does NOT suppress when pan gesture exists but has not moved yet (active=false)', () => {
    // The user pressed but has not moved enough to trigger a pan yet.
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'pan', gesturePanActive: false })).toBe(true);
  });

  it('suppresses during a box-select drag', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'box' })).toBe(false);
  });

  it('suppresses while moving a group', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'group' })).toBe(false);
  });

  it('suppresses while moving boards as a group', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'board-group' })).toBe(false);
  });

  it('suppresses when space bar is held', () => {
    expect(shouldShowHoleHover({ ...BASE, spaceHeld: true })).toBe(false);
  });

  it('suppresses when the middle mouse button is down', () => {
    expect(shouldShowHoleHover({ ...BASE, middleDown: true })).toBe(false);
  });

  it('suppresses during a two-finger view pan', () => {
    expect(shouldShowHoleHover({ ...BASE, viewFingers: true })).toBe(false);
  });

  // ---- single-item drag ALWAYS keeps hover (drop-target feedback) ----

  it('keeps hover while dragging a single part even when pan would suppress it', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'pan', gesturePanActive: true, isDragging: true })).toBe(true);
  });

  it('keeps hover while dragging even with space held', () => {
    expect(shouldShowHoleHover({ ...BASE, spaceHeld: true, isDragging: true })).toBe(true);
  });

  it('keeps hover while dragging even with middle button down', () => {
    expect(shouldShowHoleHover({ ...BASE, middleDown: true, isDragging: true })).toBe(true);
  });

  it('keeps hover while dragging even during two-finger pan', () => {
    expect(shouldShowHoleHover({ ...BASE, viewFingers: true, isDragging: true })).toBe(true);
  });

  it('keeps hover while dragging even during a group move', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'group', isDragging: true })).toBe(true);
  });

  // ---- other gesture kinds leave hover alone ----

  it('keeps hover during a bend drag (the wire-bend marker is distinct)', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'bend' })).toBe(true);
  });

  it('keeps hover during a span gesture (two-hole placement)', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'span' })).toBe(true);
  });

  it('keeps hover while a knob is being turned', () => {
    expect(shouldShowHoleHover({ ...BASE, gestureKind: 'knob' })).toBe(true);
  });
});

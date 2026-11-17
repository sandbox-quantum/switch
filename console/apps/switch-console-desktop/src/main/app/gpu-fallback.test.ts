import { describe, expect, it } from 'vitest';
import {
  fallbackPreference,
  GPU_CRASHES_AFTER_SHOW_LIMIT,
  GpuFallbackDetector,
  hardwareAccelerationForRun,
  parseGpuPreference,
  type GpuSignal,
} from './gpu-fallback';

const gpuGone = (reason: string): GpuSignal => ({
  kind: 'child-process-gone',
  type: 'GPU',
  reason,
  exitCode: 139,
});
const timeout: GpuSignal = { kind: 'ready-to-show-timeout', timeoutMs: 20_000 };
const shown: GpuSignal = { kind: 'ready-to-show' };

describe('GpuFallbackDetector', () => {
  it('falls back when the window does not paint in time', () => {
    const detector = new GpuFallbackDetector(true);
    expect(detector.observe(timeout)).toEqual({
      fallback: true,
      detail: 'the window did not paint within 20s',
    });
  });

  it('does not fall back on a timeout after the window painted', () => {
    const detector = new GpuFallbackDetector(true);
    detector.observe(shown);
    expect(detector.observe(timeout)).toEqual({ fallback: false });
  });

  it('falls back when the GPU process crashes before the window painted', () => {
    const decision = new GpuFallbackDetector(true).observe(gpuGone('crashed'));
    expect(decision).toEqual({
      fallback: true,
      detail: 'GPU process crashed (exit code 139) before the window painted',
    });
  });

  it.each(['abnormal-exit', 'launch-failed', 'integrity-failure'])(
    'treats a GPU process %s as a failure',
    (reason) => {
      expect(new GpuFallbackDetector(true).observe(gpuGone(reason)).fallback).toBe(true);
    }
  );

  it.each(['clean-exit', 'killed', 'oom'])('ignores a GPU process that ended with %s', (reason) => {
    expect(new GpuFallbackDetector(true).observe(gpuGone(reason)).fallback).toBe(false);
  });

  it('ignores other child processes', () => {
    const decision = new GpuFallbackDetector(true).observe({
      kind: 'child-process-gone',
      type: 'Utility',
      reason: 'crashed',
      exitCode: 1,
    });
    expect(decision.fallback).toBe(false);
  });

  it('tolerates GPU crashes after the window painted until there are several', () => {
    const detector = new GpuFallbackDetector(true);
    detector.observe(shown);
    for (let i = 1; i < GPU_CRASHES_AFTER_SHOW_LIMIT; i++) {
      expect(detector.observe(gpuGone('crashed')).fallback).toBe(false);
    }
    expect(detector.observe(gpuGone('crashed'))).toEqual({
      fallback: true,
      detail: `GPU process crashed (exit code 139), ${GPU_CRASHES_AFTER_SHOW_LIMIT} times this run`,
    });
  });

  it('falls back when the renderer dies before the window painted, not after', () => {
    const crash: GpuSignal = { kind: 'render-process-gone', reason: 'crashed', exitCode: 11 };
    expect(new GpuFallbackDetector(true).observe(crash).fallback).toBe(true);

    const afterShow = new GpuFallbackDetector(true);
    afterShow.observe(shown);
    expect(afterShow.observe(crash).fallback).toBe(false);
  });

  it('never falls back in a run already without hardware acceleration', () => {
    const detector = new GpuFallbackDetector(false);
    expect(detector.observe(gpuGone('crashed')).fallback).toBe(false);
    expect(detector.observe(timeout).fallback).toBe(false);
  });

  it('decides to fall back only once', () => {
    const detector = new GpuFallbackDetector(true);
    expect(detector.observe(gpuGone('crashed')).fallback).toBe(true);
    expect(detector.observe(timeout).fallback).toBe(false);
  });
});

describe('hardwareAccelerationForRun', () => {
  it('follows the saved choice', () => {
    expect(hardwareAccelerationForRun({ hardwareAcceleration: true }, false)).toBe(true);
    expect(hardwareAccelerationForRun({ hardwareAcceleration: false, by: 'user' }, false)).toBe(
      false
    );
  });

  it('is off when the launch passed --disable-gpu', () => {
    expect(hardwareAccelerationForRun({ hardwareAcceleration: true }, true)).toBe(false);
  });
});

describe('parseGpuPreference', () => {
  it('defaults to on with no file or an unreadable one', () => {
    expect(parseGpuPreference(null)).toEqual({ hardwareAcceleration: true });
    expect(parseGpuPreference('not json')).toEqual({ hardwareAcceleration: true });
    expect(parseGpuPreference('null')).toEqual({ hardwareAcceleration: true });
    expect(parseGpuPreference('{"hardwareAcceleration":"no"}')).toEqual({
      hardwareAcceleration: true,
    });
  });

  it('round-trips a fallback', () => {
    const saved = fallbackPreference('GPU process crashed', new Date('2026-11-17T10:00:00Z'));
    expect(parseGpuPreference(JSON.stringify(saved))).toEqual({
      hardwareAcceleration: false,
      by: 'fallback',
      detail: 'GPU process crashed',
      at: '2026-11-17T10:00:00.000Z',
    });
  });

  it('reads a choice made in Settings', () => {
    expect(parseGpuPreference('{"hardwareAcceleration":false,"by":"user"}')).toEqual({
      hardwareAcceleration: false,
      by: 'user',
    });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { session } from '../lib/session';
import { useKeyLock } from './useKeyLock';

function Probe({ onLock }: { onLock: () => void }) {
  useKeyLock(onLock);
  return null;
}

describe('useKeyLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    session.clear();
    session.setKeyTimeout(1);
  });

  afterEach(() => {
    session.clear();
    vi.useRealTimers();
  });

  it('fires when the key auto-locks', () => {
    const onLock = vi.fn();
    const root = document.createElement('div');
    act(() => render(h(Probe, { onLock }), root));

    act(() => session.setCachedPrivateKey({} as any));
    expect(onLock).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(onLock).toHaveBeenCalledTimes(1);

    act(() => render(null, root));
  });

  it('fires when the key is locked manually', () => {
    const onLock = vi.fn();
    const root = document.createElement('div');
    act(() => render(h(Probe, { onLock }), root));

    act(() => session.setCachedPrivateKey({} as any));
    act(() => session.clearPrivateKey());
    expect(onLock).toHaveBeenCalledTimes(1);

    act(() => render(null, root));
  });

  it('does not fire when the key is unlocked', () => {
    const onLock = vi.fn();
    const root = document.createElement('div');
    act(() => render(h(Probe, { onLock }), root));

    act(() => session.setCachedPrivateKey({} as any));
    expect(onLock).not.toHaveBeenCalled();

    act(() => render(null, root));
  });
});

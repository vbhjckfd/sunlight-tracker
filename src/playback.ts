export interface PlaybackOptions {
  getMinutes: () => number;
  setMinutes: (minutes: number) => void;
  stepMinutes: number;
  maxMinutes: number;
  intervalMs: number;
  onStop: () => void;
}

export interface Playback {
  toggle(): void;
  stop(): void;
  isPlaying(): boolean;
}

/** Auto-advances a minutes-of-day value on an interval, stopping at end of day. */
export function createPlayback(options: PlaybackOptions): Playback {
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    options.onStop();
  }

  function tick(): void {
    const next = options.getMinutes() + options.stepMinutes;
    if (next > options.maxMinutes) {
      stop();
      return;
    }
    options.setMinutes(next);
  }

  function play(): void {
    if (timer !== null) return;
    timer = setInterval(tick, options.intervalMs);
  }

  return {
    toggle() {
      if (timer !== null) stop();
      else play();
    },
    stop,
    isPlaying: () => timer !== null,
  };
}

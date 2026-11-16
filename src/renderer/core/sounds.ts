/** eDEX-UI interface sounds (src/assets/audio), played through Web Audio. */
export type SoundName = 'alarm' | 'denied' | 'error' | 'expand' | 'folder' | 'granted' | 'info' | 'keyboard' | 'panels' | 'scan' | 'stdin' | 'stdout' | 'theme';
const FEEDBACK: SoundName[] = ['keyboard', 'stdin', 'stdout'];

export class Sounds {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private loading = new Map<SoundName, Promise<AudioBuffer | null>>();
  private lastPlay = new Map<SoundName, number>();
  enabled = true;
  feedback = false;
  volume = 0.6;

  private async load(name: SoundName): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(name);
    if (cached) return cached;
    let p = this.loading.get(name);
    if (!p) {
      p = (async () => {
        try {
          this.ctx ??= new AudioContext();
          const res = await fetch(`/assets/audio/${name}.wav`);
          const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
          this.buffers.set(name, buf);
          return buf;
        } catch {
          return null;
        }
      })();
      this.loading.set(name, p);
    }
    return p;
  }

  play(name: SoundName, volume = 1): void {
    if (!this.enabled || this.volume <= 0) return;
    if (FEEDBACK.includes(name) && !this.feedback) return;
    const now = performance.now();
    if (now - (this.lastPlay.get(name) ?? 0) < (FEEDBACK.includes(name) ? 45 : 80)) return;
    this.lastPlay.set(name, now);
    void this.load(name).then((buf) => {
      if (!buf || !this.ctx) return;
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.value = this.volume * volume;
      src.buffer = buf;
      src.connect(g).connect(this.ctx.destination);
      src.start();
    });
  }
}

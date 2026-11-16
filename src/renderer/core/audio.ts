/**
 * Audio-reactive analysis (Web Audio). Sources:
 *  - file:        user-chosen audio file (decoded locally)
 *  - microphone:  any input device, only after the user clicks "Start" this session
 *  - system:      loopback capture where the OS supports it (Windows, macOS 13+)
 * On Linux, system output is captured by choosing a PipeWire/PulseAudio
 * "Monitor of …" input device. Nothing is ever captured implicitly, and no
 * fake signal is substituted when a source is unavailable.
 */
import { bridge } from './bridge';
import { Emitter } from './util';

export interface Bands { level: number; bass: number; mid: number; treble: number; beat: boolean; beatPulse: number; bpm: number | null }

export type AudioSourceKind = 'none' | 'file' | 'microphone' | 'system';

export class AudioEngine {
  readonly events = new Emitter<{ state: [] }>();
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private source: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private bufferSource: AudioBufferSourceNode | null = null;
  private freq = new Uint8Array(1024);
  private time = new Uint8Array(2048);
  readonly spectrum = new Float32Array(128);
  readonly waveform = new Float32Array(512);
  bands: Bands = { level: 0, bass: 0, mid: 0, treble: 0, beat: false, beatPulse: 0, bpm: null };
  kind: AudioSourceKind = 'none';
  label = '';
  error = '';
  private retained = 0;
  private energyHist: number[] = [];
  private lastBeat = 0;
  private beatTimes: number[] = [];
  settings = { gain: 1, smoothing: 0.8, sensitivity: 1.35, monitorFile: true };

  get active(): boolean {
    return this.kind !== 'none' && !!this.analyser;
  }

  retain(): () => void {
    this.retained++;
    let released = false;
    return () => { if (!released) { released = true; this.retained--; } };
  }

  get inUse(): boolean {
    return this.retained > 0;
  }

  configure(s: Partial<AudioEngine['settings']>): void {
    this.settings = { ...this.settings, ...s };
    if (this.gain) this.gain.gain.value = this.settings.gain;
    if (this.analyser) this.analyser.smoothingTimeConstant = this.settings.smoothing;
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = this.settings.smoothing;
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.settings.gain;
      this.gain.connect(this.analyser);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.time = new Uint8Array(this.analyser.fftSize);
    }
    void this.ctx.resume();
    return this.ctx;
  }

  async stop(): Promise<void> {
    try { this.bufferSource?.stop(); } catch { /* not started */ }
    this.bufferSource?.disconnect();
    this.bufferSource = null;
    this.source?.disconnect();
    this.source = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.kind === 'microphone') await bridge.audio.allowCapture('microphone', false);
    if (this.kind === 'system') await bridge.audio.allowCapture('system', false);
    this.kind = 'none';
    this.label = '';
    this.bands = { level: 0, bass: 0, mid: 0, treble: 0, beat: false, beatPulse: 0, bpm: null };
    this.events.emit('state');
  }

  async playFile(name: string, data: Uint8Array): Promise<void> {
    await this.stop();
    const ctx = this.ensureCtx();
    try {
      const buf = await ctx.decodeAudioData(data.slice().buffer);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(this.gain!);
      if (this.settings.monitorFile) src.connect(ctx.destination);
      src.start();
      this.bufferSource = src;
      this.source = src;
      this.kind = 'file';
      this.label = name;
      this.error = '';
    } catch (e) {
      this.error = `could not decode ${name}: ${(e as Error).message}`;
    }
    this.events.emit('state');
  }

  async startMicrophone(deviceId = 'default'): Promise<void> {
    await this.stop();
    const perm = await bridge.audio.allowCapture('microphone', true);
    if (!perm.ok) { this.error = perm.error ?? 'microphone permission denied'; this.events.emit('state'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      this.attachStream(stream, 'microphone');
    } catch (e) {
      await bridge.audio.allowCapture('microphone', false);
      this.error = `microphone unavailable: ${(e as Error).message}`;
    }
    this.events.emit('state');
  }

  async startSystem(): Promise<void> {
    await this.stop();
    const perm = await bridge.audio.allowCapture('system', true);
    if (!perm.ok) { this.error = perm.error ?? 'system audio capture is not supported here'; this.events.emit('state'); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      for (const v of stream.getVideoTracks()) v.stop();
      if (!stream.getAudioTracks().length) throw new Error('the operating system returned no audio track');
      this.attachStream(stream, 'system');
    } catch (e) {
      await bridge.audio.allowCapture('system', false);
      this.error = `system audio unavailable: ${(e as Error).message}`;
    }
    this.events.emit('state');
  }

  private attachStream(stream: MediaStream, kind: AudioSourceKind): void {
    const ctx = this.ensureCtx();
    this.stream = stream;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(this.gain!);
    this.source = src;
    this.kind = kind;
    this.label = stream.getAudioTracks()[0]?.label || kind;
    this.error = '';
  }

  async inputDevices(): Promise<{ id: string; label: string }[]> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
    } catch {
      return [];
    }
  }

  /** Called once per frame by the graphics engine. */
  update(now: number): void {
    if (!this.analyser || this.kind === 'none') {
      this.bands.beatPulse *= 0.9;
      return;
    }
    const a = this.analyser;
    a.getByteFrequencyData(this.freq);
    a.getByteTimeDomainData(this.time);
    const sr = this.ctx!.sampleRate;
    const binHz = sr / a.fftSize;
    const band = (lo: number, hi: number) => {
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.min(this.freq.length - 1, Math.ceil(hi / binHz));
      let s = 0;
      for (let i = i0; i <= i1; i++) s += this.freq[i];
      return s / ((i1 - i0 + 1) * 255);
    };
    let rms = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      rms += v * v;
    }
    rms = Math.sqrt(rms / this.time.length);
    const bass = band(20, 250);
    this.bands.level = Math.min(1, rms * 2.5);
    this.bands.bass = bass;
    this.bands.mid = band(250, 4000);
    this.bands.treble = band(4000, 16000);
    // Log-spaced spectrum for visualizations.
    const n = this.spectrum.length;
    for (let i = 0; i < n; i++) {
      const f0 = 30 * Math.pow(16000 / 30, i / n);
      const f1 = 30 * Math.pow(16000 / 30, (i + 1) / n);
      this.spectrum[i] = band(f0, f1);
    }
    const step = this.time.length / this.waveform.length;
    for (let i = 0; i < this.waveform.length; i++) this.waveform[i] = (this.time[Math.floor(i * step)] - 128) / 128;
    // Energy-based beat detection on the bass band.
    const e = bass * bass;
    this.energyHist.push(e);
    if (this.energyHist.length > 60) this.energyHist.shift();
    const avg = this.energyHist.reduce((x, y) => x + y, 0) / this.energyHist.length;
    this.bands.beat = false;
    if (e > avg * this.settings.sensitivity && e > 0.02 && now - this.lastBeat > 240) {
      this.bands.beat = true;
      this.bands.beatPulse = 1;
      this.lastBeat = now;
      this.beatTimes.push(now);
      if (this.beatTimes.length > 16) this.beatTimes.shift();
      if (this.beatTimes.length >= 6) {
        const intervals = this.beatTimes.slice(1).map((t, i) => t - this.beatTimes[i]).sort((x, y) => x - y);
        const median = intervals[Math.floor(intervals.length / 2)];
        this.bands.bpm = median > 0 ? Math.round(60000 / median) : null;
      }
    } else {
      this.bands.beatPulse *= 0.9;
    }
  }
}

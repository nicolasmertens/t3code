import { PcmResampler } from "./pcmResampler";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const TARGET_FRAME_SAMPLES = 640;

class TalkToFleetCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private readonly frame = new Int16Array(TARGET_FRAME_SAMPLES);
  private frameOffset = 0;
  private active = true;
  private muted = false;
  private levelSamples = 0;
  private levelEnergy = 0;
  private level = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data === "mute") {
        this.muted = true;
        this.level = 0;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        this.port.postMessage({ type: "level", level: 0 });
        return;
      }
      if (data === "unmute") {
        this.muted = false;
        return;
      }
      if (data === "stop") {
        this.active = false;
        this.flushPartial();
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  private publishFrame() {
    const out = this.frame.slice(0, this.frameOffset);
    this.frameOffset = 0;
    this.port.postMessage({ type: "pcm", pcm: out }, [out.buffer]);
  }

  private flushPartial() {
    if (this.frameOffset > 0 && !this.muted) {
      this.publishFrame();
    }
    this.frameOffset = 0;
  }

  private appendResampled(pcm: Float32Array) {
    for (const sample of pcm) {
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      this.frame[this.frameOffset++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.frameOffset === TARGET_FRAME_SAMPLES) {
        this.publishFrame();
      }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.[0]) return true;

    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) {
      for (let i = 0; i < mono.length; i += 1) {
        mono[i]! += channel[i]! / channels.length;
      }
    }

    if (this.muted) {
      // Keep the resampler drained without buffering muted audio across an unmute boundary.
      this.resampler.push(mono);
      this.frameOffset = 0;
      return true;
    }

    for (const sample of mono) {
      this.levelEnergy += sample * sample;
      this.levelSamples += 1;
      if (this.levelSamples >= sampleRate / 20) {
        const target = Math.min(1, Math.sqrt(this.levelEnergy / this.levelSamples) * 4);
        const timeConstant = target > this.level ? 0.075 : 0.2;
        const decay = Math.exp(-this.levelSamples / sampleRate / timeConstant);
        this.level = target + (this.level - target) * decay;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        this.port.postMessage({ type: "level", level: this.level });
        this.levelEnergy = 0;
        this.levelSamples = 0;
      }
    }

    this.appendResampled(this.resampler.push(mono));
    return true;
  }
}

registerProcessor("t3-talk-to-fleet-capture", TalkToFleetCaptureProcessor);

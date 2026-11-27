const INPUT_SAMPLE_RATE = 24_000;
const BUFFER_CAPACITY = 240_000;
const PRE_ROLL_SAMPLES = 1_200;

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class TalkToFleetPlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring = new Float32Array(BUFFER_CAPACITY);
  private writeIndex = 0;
  private readIndex = 0;
  private available = 0;
  private phase = 0;
  private preRolling = true;
  private active = true;
  private speaking = false;
  private lastSample = 0;
  private fadeTotalSamples = 0;
  private fadeRemainingSamples = 0;
  private fadeStartSample = 0;
  private levelEnergy = 0;
  private levelSamples = 0;
  private level = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data === "stop") {
        this.active = false;
        return;
      }
      if (!data || typeof data !== "object") {
        return;
      }
      const message = data as { type?: string; pcm?: Int16Array };
      if (message.type === "flush") {
        this.flush();
        return;
      }
      if (message.type === "pcm" && message.pcm instanceof Int16Array) {
        this.enqueue(message.pcm);
      }
    };
  }

  private enqueue(pcm: Int16Array) {
    let source = pcm;
    if (source.length >= BUFFER_CAPACITY) {
      source = source.subarray(source.length - BUFFER_CAPACITY);
      this.readIndex = 0;
      this.writeIndex = 0;
      this.available = 0;
      this.phase = 0;
      this.preRolling = true;
    }
    for (let i = 0; i < source.length; i += 1) {
      if (this.available === BUFFER_CAPACITY) {
        // Drop oldest samples if playback ever falls behind so latency stays bounded.
        this.readIndex = (this.readIndex + 1) % BUFFER_CAPACITY;
        this.available -= 1;
      }
      this.ring[this.writeIndex] = source[i]! / 32_768;
      this.writeIndex = (this.writeIndex + 1) % BUFFER_CAPACITY;
      this.available += 1;
    }
  }

  private flush() {
    this.available = 0;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.phase = 0;
    this.preRolling = true;
    this.fadeStartSample = this.lastSample;
    this.fadeTotalSamples = Math.max(1, Math.round(sampleRate * 0.005));
    this.fadeRemainingSamples = Math.abs(this.fadeStartSample) > 1e-5 ? this.fadeTotalSamples : 0;
    this.levelEnergy = 0;
    this.levelSamples = 0;
    this.level = 0;
    if (this.speaking) {
      this.speaking = false;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      this.port.postMessage({ type: "state", speaking: false, level: 0 });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.active) {
      return false;
    }
    const outputChannels = outputs[0];
    const primary = outputChannels?.[0];
    if (!primary) {
      return true;
    }

    const step = INPUT_SAMPLE_RATE / sampleRate;
    const minLevelWindow = Math.max(1, Math.round(sampleRate / 20));

    for (let i = 0; i < primary.length; i += 1) {
      let sample = 0;
      if (this.fadeRemainingSamples > 0) {
        sample = this.fadeStartSample * (this.fadeRemainingSamples / this.fadeTotalSamples);
        this.fadeRemainingSamples -= 1;
        if (this.fadeRemainingSamples === 0) {
          this.fadeStartSample = 0;
        }
      } else {
        if (this.preRolling && this.available >= PRE_ROLL_SAMPLES) {
          this.preRolling = false;
        }
        if (!this.preRolling && this.available > 0) {
          const s0 = this.ring[this.readIndex]!;
          const s1 = this.available > 1 ? this.ring[(this.readIndex + 1) % BUFFER_CAPACITY]! : 0;
          sample = s0 + (s1 - s0) * this.phase;
          this.phase += step;
          while (this.phase >= 1 && this.available > 0) {
            this.phase -= 1;
            this.readIndex = (this.readIndex + 1) % BUFFER_CAPACITY;
            this.available -= 1;
          }
          if (this.available === 0) {
            this.phase = 0;
            this.preRolling = true;
          }
        }
      }

      this.lastSample = sample;
      primary[i] = sample;
      for (let ch = 1; ch < outputChannels.length; ch += 1) {
        outputChannels[ch]![i] = sample;
      }

      this.levelEnergy += sample * sample;
      this.levelSamples += 1;
    }

    const currentlySpeaking = !this.preRolling && this.available > 0;
    if (currentlySpeaking !== this.speaking || this.levelSamples >= minLevelWindow) {
      const sampleCount = Math.max(1, this.levelSamples);
      const target = Math.min(1, Math.sqrt(this.levelEnergy / sampleCount) * 4);
      const timeConstant = target > this.level ? 0.06 : 0.18;
      const decay = Math.exp(-sampleCount / sampleRate / timeConstant);
      this.level = currentlySpeaking ? target + (this.level - target) * decay : 0;
      this.speaking = currentlySpeaking;
      this.levelEnergy = 0;
      this.levelSamples = 0;
      const stateEvent = {
        type: "state",
        speaking: currentlySpeaking,
        level: currentlySpeaking ? this.level : 0,
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
      this.port.postMessage(stateEvent);
    }

    return true;
  }
}

registerProcessor("t3-talk-to-fleet-playback", TalkToFleetPlaybackProcessor);

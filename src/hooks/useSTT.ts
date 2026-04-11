"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type STTStatus = "idle" | "requesting_permission" | "connecting" | "recording" | "paused";
export type STTSpeaker = "doctor" | "patient";

export interface STTSegment {
  id: string;
  text: string;
  speaker?: STTSpeaker;
  timestamp: string;
  confidence: number;
  is_final: boolean;
  start_ms?: number;
  end_ms?: number;
  language?: string | null;
}

interface UseSTTArgs {
  consultationId?: string;
  transcriptId?: string;
  chunkMs?: number;
}

type DeepgramResultMessage = {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
  metadata?: {
    language?: string;
  };
};

type SarvamWsMessage = {
  type?: "data" | "error" | "events" | string;
  data?: {
    transcript?: string;
    language_code?: string | null;
    error?: string;
    message?: string;
    code?: string;
  };
};

export function useSTT({ consultationId, transcriptId, chunkMs = 250 }: UseSTTArgs = {}) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const currentSpeakerRef = useRef<STTSpeaker>("doctor");

  const [status, setStatus] = useState<STTStatus>("idle");
  const [segments, setSegments] = useState<STTSegment[]>([]);
  const [interimText, setInterimText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);

  const fullText = useMemo(() => segments.filter((s) => s.is_final).map((s) => s.text).join(" ").trim(), [segments]);

  const cleanup = useCallback(() => {
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      // ignore
    }
    try {
      audioProcessorRef.current?.disconnect();
      audioSourceRef.current?.disconnect();
      void audioContextRef.current?.close();
    } catch {
      // ignore
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    wsRef.current?.close();
    mediaRecorderRef.current = null;
    audioContextRef.current = null;
    audioSourceRef.current = null;
    audioProcessorRef.current = null;
    streamRef.current = null;
    wsRef.current = null;
    setInterimText("");
  }, []);

  const getSarvamConfig = useCallback(async () => {
    const res = await fetch("/api/stt/token", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to get token");
    return {
      provider: String(data.provider ?? "sarvam"),
    };
  }, []);

  const floatTo16BitPcm = useCallback((samples: Float32Array) => {
    const output = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return output;
  }, []);

  const downsampleBuffer = useCallback((input: Float32Array, inputSampleRate: number, outputSampleRate: number) => {
    if (outputSampleRate === inputSampleRate) return input;
    if (outputSampleRate > inputSampleRate) return input;

    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(input.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
        accum += input[i];
        count += 1;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }, []);

  const startSarvamCapture = useCallback(
    async (stream: MediaStream, ws: WebSocket) => {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      const gain = audioContext.createGain();
      gain.gain.value = 0;

      audioSourceRef.current = source;
      audioProcessorRef.current = processor;

      processor.onaudioprocess = (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
        const pcm16 = floatTo16BitPcm(downsampled);
        ws.send(pcm16.buffer);
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioContext.destination);
    },
    [downsampleBuffer, floatTo16BitPcm]
  );

  const start = useCallback(async () => {
    if (!consultationId) {
      setError("Missing consultationId");
      return;
    }
    if (status !== "idle") return;

    try {
      setError(null);
      setStatus("requesting_permission");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      setStatus("connecting");
      await getSarvamConfig();

      const wsUrl = (() => {
        const params = new URLSearchParams({
          "language-code": "unknown",
          model: "saaras:v3",
          mode: "codemix",
          sample_rate: "16000",
          input_audio_codec: "wav",
          vad_signals: "true",
        });
        return `ws://127.0.0.1:8787/speech-to-text/ws?${params.toString()}`;
      })();

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("recording");

        void startSarvamCapture(stream, ws);
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as SarvamWsMessage;

          if (parsed.type === "error") {
            setError(parsed.data?.message ?? parsed.data?.error ?? "Sarvam STT error");
            return;
          }

          if (parsed.type === "events") {
            return;
          }

          if (parsed.type !== "data") return;

          const text = String(parsed.data?.transcript ?? "").trim();
          if (!text) return;

          if (parsed.data?.language_code) setDetectedLanguage(parsed.data.language_code);

          setSegments((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              text,
              speaker: currentSpeakerRef.current,
              confidence: 1,
              timestamp: new Date().toISOString(),
              is_final: true,
              language: parsed.data?.language_code ?? detectedLanguage,
            },
          ]);
          setInterimText("");
        } catch {
          // ignore non-json or unexpected
        }
      };

      ws.onerror = () => {
        // Browser doesn’t expose handshake status here.
        setError("Sarvam STT websocket connection failed");
        setStatus("idle");
        cleanup();
      };

      ws.onclose = (e) => {
        if (status !== "idle" && !e.reason) {
          setError("Sarvam STT closed. Make sure the local proxy is running on port 8787.");
        }
        const code = typeof e?.code === "number" ? e.code : null;
        const reason = e?.reason ? String(e.reason) : "";
        if (reason) setError(`STT closed (${code ?? "?"}): ${reason}`);
        else if (code != null) setError(`STT closed (${code}). If this persists, check DevTools → Network → WS for 401/403.`);
        if (status !== "idle") setStatus("idle");
        cleanup();
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start recording");
      setStatus("idle");
      cleanup();
    }
  }, [cleanup, consultationId, detectedLanguage, getSarvamConfig, status, startSarvamCapture]);

  const pause = useCallback(() => {
    mediaRecorderRef.current?.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback(() => {
    mediaRecorderRef.current?.resume();
    setStatus("recording");
  }, []);

  const stop = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "flush" }));
        if (status === "recording") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch {
        // ignore flush issues and fall through to cleanup
      }
    }
    cleanup();
    setStatus("idle");
    if (consultationId) {
      await fetch("/api/transcripts/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: transcriptId ?? crypto.randomUUID(),
          consultation_id: consultationId,
          raw_text: fullText,
          segments,
          processing_status: "completed",
        }),
      });
    }
  }, [cleanup, consultationId, fullText, segments, status, transcriptId]);

  useEffect(() => {
    if (!consultationId) return;
    if (segments.length === 0 && !interimText) return;
    const timer = setInterval(async () => {
      await fetch("/api/transcripts/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: transcriptId ?? crypto.randomUUID(),
          consultation_id: consultationId,
          raw_text: fullText,
          segments,
          processing_status: status === "recording" ? "in_progress" : "paused",
        }),
      });
    }, 8000);
    return () => clearInterval(timer);
  }, [consultationId, fullText, interimText, segments, status, transcriptId]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    start,
    stop,
    pause,
    resume,
    status,
    segments,
    interimText,
    detectedLanguage,
    fullText,
    error,
  };
}

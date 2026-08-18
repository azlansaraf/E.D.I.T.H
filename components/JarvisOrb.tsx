"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";

type CameraState = "off" | "starting" | "on" | "error";
type ChatRole = "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  text: string;
  sources?: Array<{ title: string; url: string }>;
}

interface RecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}

interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const messageHistoryRef = useRef<ChatMessage[]>([]);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", text: "E.D.I.T.H online. Hold the voice control or type a request." },
  ]);
  const [draft, setDraft] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [voiceReplies, setVoiceReplies] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const appendMessage = useCallback((message: ChatMessage) => {
    messageHistoryRef.current = [...messageHistoryRef.current, message].slice(-12);
    setMessages((current) => [...current, message].slice(-8));
  }, []);

  const speak = useCallback((text: string) => {
    if (!voiceReplies || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.08;
    utterance.pitch = 0.92;
    window.speechSynthesis.speak(utterance);
  }, [voiceReplies]);

  const handleLocalCommand = useCallback((text: string) => {
    const command = text.toLowerCase().replaceAll(/[.,!?]/g, " ").replaceAll(/\s+/g, " ").trim();
    let reply: string | null = null;

    if (/(zoom in|increase zoom|move closer)/.test(command)) {
      sceneRef.current?.zoomIn();
      reply = "Zooming in.";
    } else if (/(zoom out|decrease zoom|move back)/.test(command)) {
      sceneRef.current?.zoomOut();
      reply = "Zooming out.";
    } else if (/(reset|home view|reset view)/.test(command)) {
      sceneRef.current?.resetView();
      reply = "View reset.";
    } else if (/(enable|turn on|start).*(gesture|hand tracking)/.test(command)) {
      if (!trackerRef.current) void startGestures();
      reply = "Starting hand tracking. Please allow camera access if requested.";
    } else if (/(disable|turn off|stop).*(gesture|hand tracking)/.test(command)) {
      if (trackerRef.current) stopGestures();
      reply = "Hand tracking disabled.";
    }

    if (reply) {
      appendMessage({ role: "assistant", text: reply });
      speak(reply);
      return true;
    }
    return false;
  }, [appendMessage, speak, startGestures, stopGestures]);

  const sendMessage = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || isThinking) return;

    const userMessage: ChatMessage = { role: "user", text };
    appendMessage(userMessage);
    setDraft("");

    if (handleLocalCommand(text)) return;

    setIsThinking(true);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messageHistoryRef.current }),
      });
      const data = (await response.json()) as {
        reply?: string;
        error?: string;
        sources?: Array<{ title: string; url: string }>;
      };
      const reply = response.ok && data.reply
        ? data.reply
        : data.error || "I could not reach the assistant service.";
      appendMessage({ role: "assistant", text: reply, sources: data.sources });
      speak(reply);
    } catch {
      const reply = "The assistant connection failed. Check your network and API configuration.";
      appendMessage({ role: "assistant", text: reply });
      speak(reply);
    } finally {
      setIsThinking(false);
    }
  }, [appendMessage, handleLocalCommand, isThinking, speak]);

  const startListening = useCallback(() => {
    const recognitionWindow = window as Window & typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition = recognitionWindow.SpeechRecognition || recognitionWindow.webkitSpeechRecognition;
    if (!Recognition) {
      appendMessage({ role: "assistant", text: "Voice recognition is unavailable in this browser. You can type your request below." });
      return;
    }

    recognitionRef.current?.stop();
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = (event) => {
      setIsListening(false);
      if (event.error !== "aborted") {
        appendMessage({ role: "assistant", text: "Voice input was unavailable. Check microphone permission and try again." });
      }
    };
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript;
        if (event.results[index].isFinal) void sendMessage(transcript);
      }
    };
    recognitionRef.current = recognition;
    recognition.start();
  }, [appendMessage, sendMessage]);

  useEffect(() => {
    const recognitionWindow = window as Window & typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    setSpeechSupported(Boolean(recognitionWindow.SpeechRecognition || recognitionWindow.webkitSpeechRecognition));
    return () => {
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="dashboard-frame" aria-hidden="true">
        <div className="command-rail">
          <span className="rail-mark">E.D.I.T.H</span>
          <span>ORBITAL INTERFACE</span>
          <span>VISUAL CORE</span>
          <span>HAND INPUT</span>
          <span className="rail-state">SYSTEM NOMINAL</span>
        </div>

        <aside className="telemetry-stack telemetry-left">
          <section className="telemetry-panel clock-panel">
            <span className="panel-label">LOCAL TIME / IST</span>
            <strong>06:29<span>:</span>37</strong>
            <div className="micro-readout">SUNDAY · 16 AUG · 2026</div>
          </section>
          <section className="telemetry-panel radar-panel">
            <span className="panel-label">PROXIMITY SCAN</span>
            <div className="radar"><i /><i /><i /><b /></div>
            <div className="micro-readout">CLEAR SECTOR · 360° SWEEP</div>
          </section>
          <section className="telemetry-panel data-panel">
            <span className="panel-label">CORE TELEMETRY</span>
            <div className="data-row"><span>FIELD STABILITY</span><b>98.4%</b></div>
            <div className="meter"><i style={{ width: "84%" }} /></div>
            <div className="data-row"><span>LINK INTEGRITY</span><b>ACTIVE</b></div>
            <div className="meter"><i style={{ width: "72%" }} /></div>
          </section>
        </aside>

        <aside className="telemetry-stack telemetry-right">
          <section className="telemetry-panel system-panel">
            <span className="panel-label">SYSTEM LOAD</span>
            <div className="waveform"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
            <div className="data-row"><span>RENDER</span><b>60 FPS</b></div>
          </section>
          <section className="telemetry-panel objective-panel">
            <span className="panel-label">ACTIVE OBJECTIVE</span>
            <strong>VISUAL CORE</strong>
            <p>ROTATION ENABLED<br />GESTURE LINK READY</p>
            <div className="objective-grid"><i /><i /><i /><i /><i /><i /></div>
          </section>
          <section className="telemetry-panel coordinate-panel">
            <span className="panel-label">COORDINATES</span>
            <strong>19.0760° N</strong>
            <strong>72.8777° E</strong>
          </section>
        </aside>

        <div className="orbit-scale orbit-scale-left"><span>ALTITUDE</span><b>06.29</b></div>
        <div className="orbit-scale orbit-scale-right"><span>RANGE</span><b>05.50</b></div>
        <div className="center-reticle"><i /><b>EDITH</b><i /></div>
      </div>

      <div className="hud hud-title">E.D.I.T.H.</div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      <section className="assistant-console" aria-label="E.D.I.T.H voice assistant">
        <div className="assistant-console-header">
          <div>
            <span className="console-kicker">E.D.I.T.H ASSISTANT · SEARCH LINKED</span>
            <strong>{isListening ? "LISTENING" : isThinking ? "THINKING" : "READY"}</strong>
          </div>
          <button
            type="button"
            className={`voice-toggle${voiceReplies ? " active" : ""}`}
            onClick={() => setVoiceReplies((enabled) => !enabled)}
            aria-pressed={voiceReplies}
          >
            VOICE {voiceReplies ? "ON" : "OFF"}
          </button>
        </div>

        <div className="assistant-transcript" aria-live="polite">
          {messages.map((message, index) => (
            <p className={message.role} key={`${message.role}-${index}-${message.text}`}>
              <span>{message.role === "assistant" ? "EDITH" : "YOU"}</span>{message.text}
              {message.sources && message.sources.length > 0 && (
                <em className="grounded-sources">
                  {message.sources.map((source) => (
                    <a href={source.url} key={source.url} target="_blank" rel="noreferrer">
                      {source.title}
                    </a>
                  ))}
                </em>
              )}
            </p>
          ))}
          {isThinking && <p className="assistant pending"><span>EDITH</span>Processing request…</p>}
        </div>

        <form
          className="assistant-input"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage(draft);
          }}
        >
          <button
            type="button"
            className={`listen-button${isListening ? " listening" : ""}`}
            onClick={startListening}
            disabled={!speechSupported || isThinking}
            aria-label="Start voice command"
            title={speechSupported ? "Speak a command" : "Voice recognition is unavailable in this browser"}
          >
            {isListening ? "STOP" : "TALK"}
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask E.D.I.T.H…"
            aria-label="Message E.D.I.T.H"
            disabled={isThinking}
          />
          <button type="submit" className="send-button" disabled={!draft.trim() || isThinking}>SEND</button>
        </form>
      </section>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}

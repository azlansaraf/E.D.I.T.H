import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

type GroundedSource = {
  title: string;
  url: string;
};

const EDITH_INSTRUCTIONS = `You are E.D.I.T.H., a concise, capable voice assistant embedded in a personal holographic dashboard. Be helpful, calm, and direct. Keep answers suitable for speech: normally no more than three short sentences. Do not claim to control hardware, access private data, browse the web, or perform actions unless the application explicitly gives you that capability. If asked about the dashboard, explain that you can answer questions and respond to voice commands for zoom, reset, and gesture tracking.`;

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.text === "string" &&
    message.text.length > 0 &&
    message.text.length <= 4_000
  );
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "Gemini is not configured. Add GEMINI_API_KEY to .env.local." },
      { status: 503 },
    );
  }

  let body: { messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!Array.isArray(body.messages)) {
    return NextResponse.json({ error: "Messages are required." }, { status: 400 });
  }

  const messages = body.messages.filter(isChatMessage).slice(-12);
  if (messages.length === 0) {
    return NextResponse.json({ error: "No valid message was provided." }, { status: 400 });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: EDITH_INSTRUCTIONS }] },
      tools: [{ google_search: {} }],
      contents: messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.text }],
      })),
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 350,
      },
    }),
    signal: AbortSignal.timeout(30_000),
    },
  );

  const data = (await response.json()) as {
    error?: { message?: string };
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
      };
    }>;
  };

  if (!response.ok) {
    return NextResponse.json(
      { error: data.error?.message || "Gemini request failed." },
      { status: response.status },
    );
  }

  const reply = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim() || "I have no response to report.";
  const sources: GroundedSource[] = [];
  const seenUrls = new Set<string>();
  for (const chunk of data.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
    const url = chunk.web?.uri;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    sources.push({ title: chunk.web?.title || url, url });
    if (sources.length === 5) break;
  }

  return NextResponse.json({ reply, sources });
}

/**
 * AI client abstraction.
 * Supports NVIDIA NIM (via OpenAI-compatible API), plain OpenAI, and mock.
 * Switch between them with AI_PROVIDER in .env.
 */
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AI_PROVIDER, NVIDIA, OPENAI } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Response & Client Interfaces
// ---------------------------------------------------------------------------

export interface AiResponse {
  content: string;
  finishReason?: string | null;
  model: string;
  rawLength: number;
  httpStatus?: number;
}

export interface AiClient {
  chat(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string>;
  chatDetailed?(messages: OpenAI.ChatCompletionMessageParam[]): Promise<AiResponse>;
}

// ---------------------------------------------------------------------------
// Diagnostic Logging (strictly non-secret)
// ---------------------------------------------------------------------------

export interface AiDiagnosticInfo {
  model: string;
  httpStatus?: number;
  finishReason?: string | null;
  responseLength?: number;
  errorMessage?: string;
}

export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/nvapi-[A-Za-z0-9._-]+/gi, "nvapi-[REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "sk-[REDACTED]")
    .replace(/fc-[A-Za-z0-9._-]+/gi, "fc-[REDACTED]");
}

export function logAiDiagnostic(info: AiDiagnosticInfo): void {
  const parts: string[] = [`model: ${info.model}`];
  if (info.httpStatus !== undefined) parts.push(`HTTP status: ${info.httpStatus}`);
  if (info.finishReason) parts.push(`finish reason: ${info.finishReason}`);
  if (info.responseLength !== undefined) parts.push(`response length: ${info.responseLength} chars`);
  if (info.errorMessage) parts.push(`error: ${sanitizeErrorMessage(info.errorMessage)}`);

  console.warn(`[AI Diagnostic] ${parts.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// NVIDIA NIM Client (OpenAI-compatible)
// ---------------------------------------------------------------------------

function buildNvidiaClient(): AiClient {
  const apiKey = process.env["NVIDIA_API_KEY"] ?? NVIDIA.apiKey;
  const baseUrl = process.env["NVIDIA_BASE_URL"] ?? NVIDIA.baseUrl;
  const model = process.env["NVIDIA_MODEL"] ?? NVIDIA.model;

  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is not set.\n" +
        "Copy .env.example to .env and add your NVIDIA NIM API key.\n" +
        "For testing without keys, set AI_PROVIDER=mock in .env"
    );
  }

  const openai = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: 45000,
  });

  async function executeChat(messages: OpenAI.ChatCompletionMessageParam[]): Promise<AiResponse> {
    const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    };

    let res: OpenAI.ChatCompletion;
    try {
      res = await openai.chat.completions.create(params);
    } catch (err: unknown) {
      const errorObj = err as Record<string, unknown>;
      const status = (errorObj?.status ?? errorObj?.statusCode) as number | undefined;
      const rawMsg = String(errorObj?.message ?? err);
      const cleanMsg = sanitizeErrorMessage(rawMsg);
      logAiDiagnostic({
        model,
        httpStatus: status,
        errorMessage: cleanMsg,
      });
      throw new Error(`NVIDIA AI request failed${status ? ` (HTTP ${status})` : ""}: ${cleanMsg}`);
    }

    let choice = res.choices[0];
    let content = choice?.message?.content ?? "";

    const finishReason = choice?.finish_reason;
    const responseModel = res.model || model;

    return {
      content,
      finishReason,
      model: responseModel,
      rawLength: content.length,
      httpStatus: 200,
    };
  }

  return {
    async chat(messages) {
      const detailed = await executeChat(messages);
      return detailed.content;
    },
    async chatDetailed(messages) {
      return executeChat(messages);
    },
  };
}

// ---------------------------------------------------------------------------
// Plain OpenAI Client
// ---------------------------------------------------------------------------

function buildOpenAiClient(): AiClient {
  const apiKey = process.env["OPENAI_API_KEY"] ?? OPENAI.apiKey;
  const model = process.env["OPENAI_MODEL"] ?? OPENAI.model;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.\n" +
        "Copy .env.example to .env and add your OpenAI API key."
    );
  }
  const openai = new OpenAI({ apiKey });

  async function executeChat(messages: OpenAI.ChatCompletionMessageParam[]): Promise<AiResponse> {
    const res = await openai.chat.completions.create({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
      response_format: { type: "json_object" },
    });
    const choice = res.choices[0];
    const content = choice?.message?.content ?? "";
    return {
      content,
      finishReason: choice?.finish_reason,
      model: res.model || model,
      rawLength: content.length,
      httpStatus: 200,
    };
  }

  return {
    async chat(messages) {
      const detailed = await executeChat(messages);
      return detailed.content;
    },
    async chatDetailed(messages) {
      return executeChat(messages);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Client
// ---------------------------------------------------------------------------

function buildMockClient(): AiClient {
  async function getMockContent(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> {
    const systemMsg = messages.find((m) => m.role === "system");
    const systemContent =
      typeof systemMsg?.content === "string" ? systemMsg.content : "";

    if (systemContent.includes("icpScore")) {
      const fixturePath = path.resolve(__dirname, "../../data/fixtures/mock_ai_people.json");
      if (fs.existsSync(fixturePath)) {
        return fs.readFileSync(fixturePath, "utf-8");
      }
      return buildMockPeopleResponse();
    } else {
      const fixturePath = path.resolve(__dirname, "../../data/fixtures/mock_ai_posts.json");
      if (fs.existsSync(fixturePath)) {
        return fs.readFileSync(fixturePath, "utf-8");
      }
      return buildMockPostsResponse();
    }
  }

  return {
    async chat(messages) {
      return getMockContent(messages);
    },
    async chatDetailed(messages) {
      const content = await getMockContent(messages);
      return {
        content,
        finishReason: "stop",
        model: "mock",
        rawLength: content.length,
        httpStatus: 200,
      };
    },
  };
}

function buildMockPeopleResponse(): string {
  return JSON.stringify({
    people: [
      {
        name: "Priya Sharma",
        profileUrl: "https://www.linkedin.com/in/priya-sharma-aspiring-pm",
        headline: "Software Engineer at TCS | Aspiring Product Manager | Currently learning PM frameworks",
        icpScore: 91,
        segment: "Career Switcher",
        whyRelevant: [
          "Software engineer actively studying PM frameworks",
          "Completed Google PM certificate -- shows commitment",
          "Mentions user research and roadmaps -- understands PM scope",
        ],
        painPoints: [
          "Lacks structured practice environment to apply PM theory",
          "Preparing for PM interviews without real product work experience",
        ],
        personalizationHook: "She has done a PM certificate but is still in an SDE role -- the gap between knowing PM theory and actually practicing it is exactly what Prodily addresses.",
        suggestedMessage: "Hi Priya, I came across your profile and noticed you are preparing to transition into PM after your Google certificate -- that takes real commitment.\n\nI am building Prodily, a free platform for aspiring PMs to go from learning concepts to actually doing structured product work, and I am looking for honest feedback from people like you.\n\nWould you be open to trying it for free and telling me what does not work? No sales pitch -- I genuinely want the critique.",
        confidence: "high",
        warnings: [],
      },
      {
        name: "Rahul Verma",
        profileUrl: "https://www.linkedin.com/in/rahul-verma-pm-aspirant",
        headline: "MBA Student at IIM-B | Breaking into Product Management | PM enthusiast",
        icpScore: 87,
        segment: "MBA Student",
        whyRelevant: [
          "MBA student actively targeting PM roles",
          "Engineering background -- technical credibility",
          "Working on PM portfolio -- needs structured practice",
        ],
        painPoints: [
          "Needs practical PM experience to complement MBA",
          "Portfolio building without real PM role is hard",
        ],
        personalizationHook: "MBA with engineering background targeting PM -- exactly the profile that benefits from structured practical exercises rather than just theory.",
        suggestedMessage: "Hi Rahul, saw you are at IIM-B targeting PM roles after your engineering background -- that combination is actually quite strong for product.\n\nI am building Prodily, a free platform to help people like you practice real PM work -- structured exercises, not just theory.\n\nWould you be willing to try it and give me brutally honest feedback? No commitment required.",
        confidence: "high",
        warnings: [],
      },
      {
        name: "Aisha Patel",
        profileUrl: "https://www.linkedin.com/in/aisha-patel-career-transition",
        headline: "UX Designer transitioning to Product Management | 2 years UX experience",
        icpScore: 88,
        segment: "Career Switcher",
        whyRelevant: [
          "Active transition from UX to PM -- clear intent",
          "2 years UX experience is a strong asset for PM",
          "Completed Reforge PM course -- serious about the transition",
        ],
        painPoints: [
          "Wants to demonstrate PM skills beyond design",
          "Building product case studies without PM role context",
        ],
        personalizationHook: "UX to PM is a natural move, but she needs to demonstrate product thinking beyond design -- Prodily gives her structured exercises to build that.",
        suggestedMessage: "Hi Aisha, I noticed you are transitioning from UX to PM after the Reforge course -- that is a smart move given how much UX experience translates.\n\nI am building Prodily, a free platform for aspiring PMs to practice structured product work, and I would love your perspective as someone coming from a design background.\n\nWould you try it and tell me what is missing? Honest criticism is exactly what I need right now.",
        confidence: "high",
        warnings: [],
      },
    ],
  });
}

function buildMockPostsResponse(): string {
  return JSON.stringify({
    posts: [
      {
        authorName: "Rahul Verma",
        postUrl: "https://www.linkedin.com/posts/rahul-verma_pminterview-breakingintoproduct-activity-7100000000000002",
        postSummary: "Aspiring PM asking for tips on structuring PM interview case study questions after a difficult mock interview.",
        relevanceScore: 88,
        whyRelevant: "Directly asks for help with PM interview prep -- a community where Prodily users exist.",
        suggestedComment: "Structuring product design cases usually becomes much easier once you build a habit of breaking problems into user segments first, then jobs-to-be-done, before jumping to solutions. What framework were you given in the mock? Sometimes the issue is more about depth of insight than structure itself.",
        confidence: "high",
        warnings: [],
      },
      {
        authorName: "Nikhil Gupta",
        postUrl: "https://www.linkedin.com/posts/nikhil-gupta_productmanagement-learning-activity-7100000000000009",
        postSummary: "Someone 3 months into their PM learning journey sharing resources they found useful and asking for more structured recommendations.",
        relevanceScore: 84,
        whyRelevant: "Explicitly asking for structured PM learning resources -- high relevance for Prodily.",
        suggestedComment: "The jump from reading about PM to actually doing PM work is where most learners get stuck. Inspired by Cagan is essential reading, but pairing it with structured exercises where you write real PRDs, prioritise features, and build decision frameworks makes the concepts stick much faster. Worth trying that alongside Lenny's newsletter.",
        confidence: "high",
        warnings: [],
      },
      {
        authorName: "Dev Kumar",
        postUrl: "https://www.linkedin.com/posts/dev-kumar_pmportfolio-productmanagement-activity-7100000000000004",
        postSummary: "CS student asking how to build a PM portfolio without prior PM experience.",
        relevanceScore: 90,
        whyRelevant: "Exactly the problem Prodily solves -- building PM portfolio without a PM role.",
        suggestedComment: "Product teardowns are a solid start, but the most compelling portfolio pieces tend to be ones where you go full-cycle: identify a user problem, write a proper PRD, define success metrics, and defend your prioritisation decisions. Even a mock project done rigorously signals to hiring managers that you can think like a PM, not just critique like one.",
        confidence: "high",
        warnings: [],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _cachedClient: AiClient | null = null;
let _cachedProvider: string | null = null;

export function getAiClient(): AiClient {
  const provider = (process.env["AI_PROVIDER"] ?? AI_PROVIDER) as string;
  if (_cachedClient && _cachedProvider === provider) {
    return _cachedClient;
  }
  switch (provider) {
    case "nvidia":
      _cachedClient = buildNvidiaClient();
      break;
    case "openai":
      _cachedClient = buildOpenAiClient();
      break;
    default:
      _cachedClient = buildMockClient();
  }
  _cachedProvider = provider;
  return _cachedClient;
}

export function getMockAiClient(): AiClient {
  return buildMockClient();
}

// ---------------------------------------------------------------------------
// Robust JSON Extraction
// ---------------------------------------------------------------------------

export function extractJson(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }

  // 1. Check for complete markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.length > 0) {
      return inner;
    }
  }

  // 2. Check for an unclosed fence (truncated response from model)
  const unclosedFence = trimmed.match(/```(?:json)?\s*([\s\S]+)$/);
  const candidateText = unclosedFence?.[1] ? unclosedFence[1].trim() : trimmed;

  // 3. Find outer root object `{ ... }` or array `[ ... ]`
  const firstBrace = candidateText.indexOf("{");
  const firstBracket = candidateText.indexOf("[");

  let startIdx = -1;
  let endIdx = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = candidateText.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = candidateText.lastIndexOf("]");
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    return candidateText.slice(startIdx, endIdx + 1).trim();
  }

  // If start was found but no closing delimiter (truncated JSON)
  if (startIdx !== -1) {
    return candidateText.slice(startIdx).trim();
  }

  return candidateText;
}

// ---------------------------------------------------------------------------
// chatJson with Non-Empty Validation, Extraction, Retries, and Diagnostics
// ---------------------------------------------------------------------------

const MAX_JSON_RETRIES = 2;

export interface ChatJsonOptions {
  maxRetries?: number;
  expectedShapeHint?: string;
}

export async function chatJson<T>(
  client: AiClient,
  messages: OpenAI.ChatCompletionMessageParam[],
  validate: (raw: unknown) => T,
  options: ChatJsonOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_JSON_RETRIES;
  let currentMessages = [...messages];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let responseText = "";
    let finishReason: string | null | undefined = undefined;
    let modelName = "unknown";
    let rawLength = 0;
    let httpStatus: number | undefined = undefined;

    try {
      if (typeof client.chatDetailed === "function") {
        const detailed = await client.chatDetailed(currentMessages);
        responseText = detailed.content;
        finishReason = detailed.finishReason;
        modelName = detailed.model;
        rawLength = detailed.rawLength;
        httpStatus = detailed.httpStatus;
      } else {
        responseText = await client.chat(currentMessages);
        rawLength = responseText?.length ?? 0;
      }

      // 1. Validate non-empty content
      if (!responseText || responseText.trim().length === 0) {
        logAiDiagnostic({
          model: modelName,
          finishReason,
          responseLength: 0,
          httpStatus,
          errorMessage: "AI returned empty response",
        });
        throw new Error(
          `AI returned an empty response (length: 0, finishReason: ${finishReason ?? "unknown"}, model: ${modelName})`
        );
      }

      // 2. Check for truncation diagnostic
      if (finishReason === "length") {
        logAiDiagnostic({
          model: modelName,
          finishReason: "length",
          responseLength: rawLength,
          errorMessage: "Response truncated due to max_tokens limit",
        });
      }

      // 3. Extract JSON
      const jsonText = extractJson(responseText);
      if (!jsonText || jsonText.trim().length === 0) {
        logAiDiagnostic({
          model: modelName,
          finishReason,
          responseLength: rawLength,
          errorMessage: "Could not extract JSON from response",
        });
        throw new Error(
          `No JSON could be extracted from AI response (length: ${rawLength}, finishReason: ${finishReason ?? "unknown"}, model: ${modelName})`
        );
      }

      // 4. Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseErr) {
        const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        logAiDiagnostic({
          model: modelName,
          finishReason,
          responseLength: rawLength,
          errorMessage: `JSON parse error: ${parseMsg}`,
        });
        throw new Error(`JSON parse error: ${parseMsg}`);
      }

      // 5. Validate against schema
      let validated: T;
      try {
        validated = validate(parsed);
      } catch (valErr) {
        const valMsg = valErr instanceof Error ? valErr.message : String(valErr);
        logAiDiagnostic({
          model: modelName,
          finishReason,
          responseLength: rawLength,
          errorMessage: `Schema validation error: ${valMsg}`,
        });
        throw new Error(`Schema validation error: ${valMsg}`);
      }

      return validated;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        console.warn(
          `[AI Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}. Retrying with correction prompt...`
        );
        const shapeHint = options.expectedShapeHint ? ` Expected JSON format: ${options.expectedShapeHint}` : "";
        currentMessages = [
          ...currentMessages,
          {
            role: "assistant",
            content: responseText || "(empty response)",
          },
          {
            role: "user",
            content:
              `Your previous response could not be parsed as valid JSON: ${lastError.message}.\n` +
              `Please respond with ONLY a single valid JSON object or array. Do NOT include markdown fences, code blocks, or any introductory or concluding text.${shapeHint}`,
          },
        ];
      }
    }
  }

  throw lastError ?? new Error("AI returned invalid JSON after retries");
}
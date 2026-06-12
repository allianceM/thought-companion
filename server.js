import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

function loadEnvFile() {
  const envPath = join(__dirname, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const port = Number(process.env.PORT || 3334);
const host = process.env.HOST || "127.0.0.1";
const apiKey = process.env.OPENAI_API_KEY;
const accessCode = process.env.ACCESS_CODE || "";
const realtimeModel = process.env.REALTIME_MODEL || "gpt-realtime-2";
const translationModel = process.env.TRANSLATION_MODEL || "gpt-realtime-translate";
const textModel = process.env.TEXT_MODEL || "gpt-5.5";
const realtimeVoice = process.env.REALTIME_VOICE || "marin";
const preferredSearchToolType = process.env.WEB_SEARCH_TOOL_TYPE || "web_search";
const execFileAsync = promisify(execFile);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8" });
}

function isAuthorized(req) {
  if (!accessCode) {
    return true;
  }

  return req.headers["x-access-code"] === accessCode;
}

function requireAccess(req, res) {
  if (isAuthorized(req)) {
    return true;
  }

  sendJson(res, 401, {
    error: "Access code required.",
    code: "access_required"
  });
  return false;
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]");
}

function describeError(error) {
  const parts = [];
  let current = error;

  while (current) {
    const message = redactSensitive([current.code, current.message].filter(Boolean).join(": "));
    if (message && !parts.includes(message)) {
      parts.push(message);
    }
    current = current.cause;
  }

  return parts.join(" | ") || "unknown error";
}

function getProxyEnv() {
  const env = {};
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;

  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy;
  }
  if (httpProxy) {
    env.HTTP_PROXY = httpProxy;
  }
  if (allProxy) {
    env.ALL_PROXY = allProxy;
  }

  return Object.keys(env).length ? env : undefined;
}

let cachedSystemProxyEnv;

function valueFromScutil(stdout, key) {
  const pattern = new RegExp(`${key}\\s*:\\s*([^\\n]+)`);
  return pattern.exec(stdout)?.[1]?.trim();
}

async function getSystemProxyEnv() {
  if (cachedSystemProxyEnv !== undefined) {
    return cachedSystemProxyEnv;
  }

  cachedSystemProxyEnv = undefined;

  try {
    const { stdout } = await execFileAsync("scutil", ["--proxy"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024
    });

    const httpsEnabled = valueFromScutil(stdout, "HTTPSEnable") === "1";
    const httpEnabled = valueFromScutil(stdout, "HTTPEnable") === "1";
    const socksEnabled = valueFromScutil(stdout, "SOCKSEnable") === "1";
    const env = {};

    if (httpsEnabled) {
      const proxy = valueFromScutil(stdout, "HTTPSProxy");
      const portValue = valueFromScutil(stdout, "HTTPSPort");
      if (proxy && portValue) {
        env.HTTPS_PROXY = `http://${proxy}:${portValue}`;
      }
    }

    if (httpEnabled) {
      const proxy = valueFromScutil(stdout, "HTTPProxy");
      const portValue = valueFromScutil(stdout, "HTTPPort");
      if (proxy && portValue) {
        env.HTTP_PROXY = `http://${proxy}:${portValue}`;
      }
    }

    if (!env.HTTPS_PROXY && !env.HTTP_PROXY && socksEnabled) {
      const proxy = valueFromScutil(stdout, "SOCKSProxy");
      const portValue = valueFromScutil(stdout, "SOCKSPort");
      if (proxy && portValue) {
        env.ALL_PROXY = `socks5h://${proxy}:${portValue}`;
      }
    }

    cachedSystemProxyEnv = Object.keys(env).length ? env : undefined;
  } catch {
    cachedSystemProxyEnv = undefined;
  }

  return cachedSystemProxyEnv;
}

function proxySource(proxyEnv) {
  if (!proxyEnv) {
    return "direct";
  }
  if (proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY) {
    return proxyEnv.HTTPS_PROXY || proxyEnv.HTTP_PROXY;
  }
  return proxyEnv.ALL_PROXY || "configured";
}

async function getEffectiveProxyEnv() {
  return getProxyEnv() || (await getSystemProxyEnv());
}

async function readJson(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanText(value, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function trimForPrompt(value, limit = 12000) {
  const text = String(value || "").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[Content trimmed for length.]`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function getVoiceSpeed(payload = {}) {
  return Number(clampNumber(payload.voiceSpeed, 0.25, 1.5, 1).toFixed(2));
}

function getNoiseReduction(payload = {}) {
  const micScene = cleanText(payload.micScene, "near");
  return {
    type: micScene === "far" ? "far_field" : "near_field"
  };
}

function getTurnDetection(payload = {}) {
  const mode = cleanText(payload.vadMode, "balanced");
  const eagerness = {
    patient: "low",
    balanced: "auto",
    quick: "high"
  }[mode] || "auto";

  return {
    type: "semantic_vad",
    eagerness,
    create_response: true,
    interrupt_response: true
  };
}

function getTranslationLanguage(payload = {}) {
  const raw = cleanText(payload.translationTargetCustom, "") || cleanText(payload.translationTargetLanguage, "zh");
  const normalized = raw.trim();
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(normalized)) {
    return normalized;
  }
  return "zh";
}

function buildInstructions(payload = {}) {
  const name = cleanText(payload.companionName, "思绪搭子");
  const language = cleanText(payload.language, "默认中文，可自然切换英文或其他语言");
  const style = cleanText(payload.style, "像朋友一样温和、直接、会追问，也会诚实说不确定");
  const focus = cleanText(payload.focus, "帮我整理思绪、回答轻量问题、翻译表达、练习发音和做简短复盘");
  const recentContext = trimForPrompt(payload.recentContext || "", 9000);

  const instructions = [
    `You are ${name}, a voice-first thinking companion.`,
    `Default language: ${language}. If the user switches language, follow them naturally.`,
    `Tone: ${style}. Be warm, clear, grounded, and conversational.`,
    `Main job: ${focus}.`,
    "",
    "Core behavior:",
    "- Keep spoken replies concise. For complex topics, give the useful first layer, then ask whether to go deeper.",
    "- Help the user think out loud. Reflect back structure, hidden assumptions, tensions, and possible next steps.",
    "- Ask at most one focused follow-up question when the user's thought is fuzzy.",
    "- For translation, wording, pronunciation, or language practice, give the phrase, a natural variant, and a short spoken pronunciation cue.",
    "- Do not pretend to know things. Never invent dates, prices, citations, laws, medical facts, financial facts, or current events.",
    "- If a factual answer depends on current or precise information, say it may need checking and suggest using the search button.",
    "- If the user asks about a high-stakes topic such as medical, legal, financial, or safety decisions, be cautious and recommend verifying with a qualified source.",
    "- When you are uncertain, explicitly say what is known, what is uncertain, and what would need checking.",
    "- Do not claim that you searched the web unless a verified search result was provided in the conversation.",
    "",
    "When verified search results are provided:",
    "- Treat them as the only source-backed current information.",
    "- Mention uncertainty if sources disagree or are thin.",
    "- Keep citations in text brief; the UI will show source links separately.",
    "",
    "Recent local browser transcript context:",
    recentContext || "(No prior transcript provided.)"
  ];

  return instructions.join("\n");
}

async function callRealtimeWithFetch(sdp, session) {
  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: await response.text()
  };
}

async function callRealtimeWithCurl(sdp, session, proxyEnv = undefined) {
  const tempDir = await mkdtemp(join(tmpdir(), "thought-companion-call-"));
  const sdpPath = join(tempDir, "offer.sdp");
  const sessionPath = join(tempDir, "session.json");

  try {
    await writeFile(sdpPath, sdp);
    await writeFile(sessionPath, JSON.stringify(session));

    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "--max-time",
        "60",
        "-w",
        "\n%{http_code}",
        "https://api.openai.com/v1/realtime/calls",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-F",
        `sdp=<${sdpPath}`,
        "-F",
        `session=<${sessionPath};type=application/json`
      ],
      {
        encoding: "utf8",
        env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
        maxBuffer: 4 * 1024 * 1024
      }
    );

    const match = stdout.match(/([\s\S]*)\n(\d{3})$/);
    if (!match) {
      throw new Error("curl did not return an HTTP status code.");
    }

    const status = Number(match[2]);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      body: match[1]
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function callRealtime(sdp, session) {
  const proxyEnv = await getEffectiveProxyEnv();

  if (proxyEnv) {
    try {
      return await callRealtimeWithCurl(sdp, session, proxyEnv);
    } catch (curlError) {
      try {
        return await callRealtimeWithFetch(sdp, session);
      } catch (fetchError) {
        throw new Error(
          [
            "Could not reach OpenAI Realtime API.",
            `curl with proxy ${proxySource(proxyEnv)} failed: ${describeError(curlError)}.`,
            `Node fetch fallback failed: ${describeError(fetchError)}.`,
            "Check that your VPN proxy is running and available to Terminal."
          ].join(" ")
        );
      }
    }
  }

  try {
    return await callRealtimeWithFetch(sdp, session);
  } catch (fetchError) {
    try {
      return await callRealtimeWithCurl(sdp, session);
    } catch (curlError) {
      throw new Error(
        [
          "Could not reach OpenAI Realtime API.",
          `Node fetch failed: ${describeError(fetchError)}.`,
          `curl fallback failed: ${describeError(curlError)}.`,
          "If you use a VPN/proxy, make sure it is available to Terminal, not only to the browser."
        ].join(" ")
      );
    }
  }
}

async function createTranslationClientSecretWithFetch(session) {
  const response = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ session })
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: await response.text()
  };
}

async function createTranslationClientSecretWithCurl(session, proxyEnv = undefined) {
  const tempDir = await mkdtemp(join(tmpdir(), "thought-companion-translation-secret-"));
  const bodyPath = join(tempDir, "body.json");

  try {
    await writeFile(bodyPath, JSON.stringify({ session }));

    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "--max-time",
        "60",
        "-w",
        "\n%{http_code}",
        "https://api.openai.com/v1/realtime/translations/client_secrets",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        `@${bodyPath}`
      ],
      {
        encoding: "utf8",
        env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
        maxBuffer: 2 * 1024 * 1024
      }
    );

    const match = stdout.match(/([\s\S]*)\n(\d{3})$/);
    if (!match) {
      throw new Error("curl did not return an HTTP status code.");
    }

    const status = Number(match[2]);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      body: match[1]
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function createTranslationClientSecret(session) {
  const proxyEnv = await getEffectiveProxyEnv();

  if (proxyEnv) {
    try {
      return await createTranslationClientSecretWithCurl(session, proxyEnv);
    } catch (curlError) {
      try {
        return await createTranslationClientSecretWithFetch(session);
      } catch (fetchError) {
        throw new Error(
          [
            "Could not create OpenAI translation client secret.",
            `curl with proxy ${proxySource(proxyEnv)} failed: ${describeError(curlError)}.`,
            `Node fetch fallback failed: ${describeError(fetchError)}.`
          ].join(" ")
        );
      }
    }
  }

  try {
    return await createTranslationClientSecretWithFetch(session);
  } catch (fetchError) {
    try {
      return await createTranslationClientSecretWithCurl(session);
    } catch (curlError) {
      throw new Error(
        [
          "Could not create OpenAI translation client secret.",
          `Node fetch failed: ${describeError(fetchError)}.`,
          `curl fallback failed: ${describeError(curlError)}.`
        ].join(" ")
      );
    }
  }
}

async function callTranslationWithFetch(sdp, clientSecret) {
  const response = await fetch("https://api.openai.com/v1/realtime/translations/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientSecret}`,
      "Content-Type": "application/sdp"
    },
    body: sdp
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: await response.text()
  };
}

async function callTranslationWithCurl(sdp, clientSecret, proxyEnv = undefined) {
  const tempDir = await mkdtemp(join(tmpdir(), "thought-companion-translation-call-"));
  const sdpPath = join(tempDir, "offer.sdp");

  try {
    await writeFile(sdpPath, sdp);

    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "--max-time",
        "60",
        "-w",
        "\n%{http_code}",
        "https://api.openai.com/v1/realtime/translations/calls",
        "-H",
        `Authorization: Bearer ${clientSecret}`,
        "-H",
        "Content-Type: application/sdp",
        "--data-binary",
        `@${sdpPath}`
      ],
      {
        encoding: "utf8",
        env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
        maxBuffer: 4 * 1024 * 1024
      }
    );

    const match = stdout.match(/([\s\S]*)\n(\d{3})$/);
    if (!match) {
      throw new Error("curl did not return an HTTP status code.");
    }

    const status = Number(match[2]);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      body: match[1]
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function callTranslation(sdp, clientSecret) {
  const proxyEnv = await getEffectiveProxyEnv();

  if (proxyEnv) {
    try {
      return await callTranslationWithCurl(sdp, clientSecret, proxyEnv);
    } catch (curlError) {
      try {
        return await callTranslationWithFetch(sdp, clientSecret);
      } catch (fetchError) {
        throw new Error(
          [
            "Could not reach OpenAI Realtime Translation API.",
            `curl with proxy ${proxySource(proxyEnv)} failed: ${describeError(curlError)}.`,
            `Node fetch fallback failed: ${describeError(fetchError)}.`
          ].join(" ")
        );
      }
    }
  }

  try {
    return await callTranslationWithFetch(sdp, clientSecret);
  } catch (fetchError) {
    try {
      return await callTranslationWithCurl(sdp, clientSecret);
    } catch (curlError) {
      throw new Error(
        [
          "Could not reach OpenAI Realtime Translation API.",
          `Node fetch failed: ${describeError(fetchError)}.`,
          `curl fallback failed: ${describeError(curlError)}.`
        ].join(" ")
      );
    }
  }
}

async function callResponsesWithFetch(body) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: await response.text()
  };
}

async function callResponsesWithCurl(body, proxyEnv = undefined) {
  const tempDir = await mkdtemp(join(tmpdir(), "thought-companion-responses-"));
  const bodyPath = join(tempDir, "body.json");

  try {
    await writeFile(bodyPath, JSON.stringify(body));

    const { stdout } = await execFileAsync(
      "curl",
      [
        "-sS",
        "--max-time",
        "90",
        "-w",
        "\n%{http_code}",
        "https://api.openai.com/v1/responses",
        "-H",
        `Authorization: Bearer ${apiKey}`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        `@${bodyPath}`
      ],
      {
        encoding: "utf8",
        env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
        maxBuffer: 6 * 1024 * 1024
      }
    );

    const match = stdout.match(/([\s\S]*)\n(\d{3})$/);
    if (!match) {
      throw new Error("curl did not return an HTTP status code.");
    }

    const status = Number(match[2]);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      body: match[1]
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function callResponses(body) {
  const proxyEnv = await getEffectiveProxyEnv();

  if (proxyEnv) {
    try {
      return await callResponsesWithCurl(body, proxyEnv);
    } catch (curlError) {
      try {
        return await callResponsesWithFetch(body);
      } catch (fetchError) {
        throw new Error(
          [
            "Could not reach OpenAI Responses API.",
            `curl with proxy ${proxySource(proxyEnv)} failed: ${describeError(curlError)}.`,
            `Node fetch fallback failed: ${describeError(fetchError)}.`
          ].join(" ")
        );
      }
    }
  }

  try {
    return await callResponsesWithFetch(body);
  } catch (fetchError) {
    try {
      return await callResponsesWithCurl(body);
    } catch (curlError) {
      throw new Error(
        [
          "Could not reach OpenAI Responses API.",
          `Node fetch failed: ${describeError(fetchError)}.`,
          `curl fallback failed: ${describeError(curlError)}.`
        ].join(" ")
      );
    }
  }
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function extractSources(data) {
  const sources = [];
  const seen = new Set();

  function pushSource(source) {
    const url = source?.url || source?.uri;
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    sources.push({
      title: cleanText(source.title, url),
      url
    });
  }

  for (const item of data.output || []) {
    if (Array.isArray(item.action?.sources)) {
      for (const source of item.action.sources) {
        pushSource(source);
      }
    }

    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation.type === "url_citation") {
          pushSource(annotation);
        }
      }
    }
  }

  return sources.slice(0, 8);
}

function parseResponsesJson(response) {
  try {
    return JSON.parse(response.body || "{}");
  } catch {
    return undefined;
  }
}

async function createRealtimeCall(req, res) {
  if (!requireAccess(req, res)) {
    return;
  }

  if (!apiKey) {
    send(
      res,
      500,
      "OPENAI_API_KEY is not visible to this server. Start it from a terminal that has the environment variable set.",
      { "Content-Type": "text/plain; charset=utf-8" }
    );
    return;
  }

  let payload;
  try {
    payload = await readJson(req, 768 * 1024);
  } catch (error) {
    send(res, 400, `Invalid JSON: ${error.message}`, { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (!payload.sdp || typeof payload.sdp !== "string") {
    send(res, 400, "Missing SDP offer.", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (payload.sessionMode === "translate") {
    const session = {
      model: translationModel,
      audio: {
        output: {
          language: getTranslationLanguage(payload)
        }
      }
    };

    let secretResponse;
    try {
      secretResponse = await createTranslationClientSecret(session);
    } catch (error) {
      send(res, 502, error.message, { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    if (!secretResponse.ok) {
      send(res, secretResponse.status, secretResponse.body || secretResponse.statusText, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return;
    }

    let clientSecret;
    try {
      const parsed = JSON.parse(secretResponse.body || "{}");
      clientSecret = parsed.value || parsed.client_secret?.value || parsed.client_secret;
    } catch {
      clientSecret = "";
    }

    if (!clientSecret || typeof clientSecret !== "string") {
      send(res, 502, "OpenAI did not return a translation client secret.", {
        "Content-Type": "text/plain; charset=utf-8"
      });
      return;
    }

    let response;
    try {
      response = await callTranslation(payload.sdp, clientSecret);
    } catch (error) {
      send(res, 502, error.message, { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    if (!response.ok) {
      send(res, response.status, response.body || response.statusText, { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    send(res, 200, response.body, { "Content-Type": "application/sdp; charset=utf-8" });
    return;
  }

  const session = {
    type: "realtime",
    model: realtimeModel,
    instructions: buildInstructions(payload),
    audio: {
      input: {
        noise_reduction: getNoiseReduction(payload),
        turn_detection: getTurnDetection(payload)
      },
      output: {
        voice: realtimeVoice,
        speed: getVoiceSpeed(payload)
      }
    }
  };

  let response;
  try {
    response = await callRealtime(payload.sdp, session);
  } catch (error) {
    send(res, 502, error.message, { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (!response.ok) {
    send(res, response.status, response.body || response.statusText, { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  send(res, 200, response.body, { "Content-Type": "application/sdp; charset=utf-8" });
}

async function searchWeb(req, res) {
  if (!requireAccess(req, res)) {
    return;
  }

  if (!apiKey) {
    sendJson(res, 500, { error: "OPENAI_API_KEY is not visible to this server." });
    return;
  }

  let payload;
  try {
    payload = await readJson(req, 256 * 1024);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON: ${error.message}` });
    return;
  }

  const query = cleanText(payload.query);
  if (!query) {
    sendJson(res, 400, { error: "Search query is empty." });
    return;
  }

  const context = trimForPrompt(payload.context || "", 7000);
  const makeBody = (toolType, includeSources = true) => ({
    model: textModel,
    tools: [
      {
        type: toolType
      }
    ],
    ...(includeSources ? { include: ["web_search_call.action.sources"] } : {}),
    max_output_tokens: 900,
    input: [
      {
        role: "system",
        content: [
          "You are a careful web research helper inside a voice thought companion.",
          "Answer in the user's language, usually Chinese.",
          "Use web search for current or source-backed information.",
          "Do not overstate confidence. If results are thin, conflicting, or not directly relevant, say so.",
          "Keep the answer concise and useful for a spoken follow-up."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          `Question: ${query}`,
          context ? `Recent conversation context:\n${context}` : "",
          "",
          "Please answer with:",
          "1. A direct answer in 2-5 short bullets or a short paragraph.",
          "2. A brief uncertainty note if needed.",
          "3. No fake citations; the app will show source links separately."
        ]
          .filter(Boolean)
          .join("\n")
      }
    ]
  });

  let response;
  const searchToolTypes =
    preferredSearchToolType === "web_search" ? ["web_search", "web_search_preview"] : [preferredSearchToolType];

  try {
    for (const [index, toolType] of searchToolTypes.entries()) {
      response = await callResponses(makeBody(toolType, true));
      const data = parseResponsesJson(response);
      const message = data?.error?.message || "";

      if (response.ok || index === searchToolTypes.length - 1 || !/tool|web_search|include|parameter/i.test(message)) {
        break;
      }
    }

    if (!response?.ok) {
      const data = parseResponsesJson(response);
      const message = data?.error?.message || "";
      if (/include/i.test(message)) {
        response = await callResponses(makeBody(searchToolTypes.at(-1), false));
      }
    }
  } catch (error) {
    sendJson(res, 502, { error: error.message });
    return;
  }

  const data = parseResponsesJson(response);
  if (!response.ok) {
    sendJson(res, response.status, {
      error: data?.error?.message || response.body || response.statusText
    });
    return;
  }

  sendJson(res, 200, {
    text: extractOutputText(data) || "I searched, but could not produce a reliable answer.",
    sources: extractSources(data),
    model: textModel
  });
}

async function summarizeNotes(req, res) {
  if (!requireAccess(req, res)) {
    return;
  }

  if (!apiKey) {
    sendJson(res, 500, { error: "OPENAI_API_KEY is not visible to this server." });
    return;
  }

  let payload;
  try {
    payload = await readJson(req, 768 * 1024);
  } catch (error) {
    sendJson(res, 400, { error: `Invalid JSON: ${error.message}` });
    return;
  }

  const transcript = trimForPrompt(payload.transcript || "", 26000);
  if (!transcript) {
    sendJson(res, 400, { error: "There is no transcript to summarize yet." });
    return;
  }

  const body = {
    model: textModel,
    max_output_tokens: 1100,
    input: [
      {
        role: "system",
        content: [
          "You turn a casual spoken conversation into a clear personal note.",
          "Use Chinese by default unless the transcript is mostly another language.",
          "Be faithful to the transcript. Do not add facts that were not discussed.",
          "If any factual claim seems uncertain or source-dependent, mark it as '待查证'."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "Please summarize this transcript into a concise note with these sections:",
          "- 一句话概括",
          "- 我真正关心的问题",
          "- 已经想清楚的点",
          "- 待查证 / 不确定",
          "- 下一步",
          "",
          transcript
        ].join("\n")
      }
    ]
  };

  let response;
  try {
    response = await callResponses(body);
  } catch (error) {
    sendJson(res, 502, { error: error.message });
    return;
  }

  const data = parseResponsesJson(response);
  if (!response.ok) {
    sendJson(res, response.status, {
      error: data?.error?.message || response.body || response.statusText
    });
    return;
  }

  sendJson(res, 200, {
    text: extractOutputText(data) || "I could not summarize this transcript reliably.",
    model: textModel
  });
}

async function getHealth() {
  const proxyEnv = await getEffectiveProxyEnv();
  return {
    ok: true,
    hasApiKey: Boolean(apiKey),
    realtimeModel,
    translationModel,
    textModel,
    host,
    port,
    proxy: proxySource(proxyEnv),
    requiresAccessCode: Boolean(accessCode)
  };
}

async function serveStatic(req, res) {
  const requested = new URL(req.url, `http://${req.headers.host}`).pathname;
  const safePath = requested === "/" ? "/index.html" : requested;
  const filePath = normalize(join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  try {
    const file = await readFile(filePath);
    send(res, 200, file, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
  } catch {
    send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, await getHealth());
    return;
  }

  if (req.method === "POST" && req.url === "/session") {
    await createRealtimeCall(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/search") {
    await searchWeb(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/summarize") {
    await summarizeNotes(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  send(res, 405, "Method not allowed", { "Content-Type": "text/plain; charset=utf-8" });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, host, () => {
    console.log(`Thought companion listening at http://${host}:${port}`);
  });
}

export { buildInstructions, extractOutputText, extractSources, getHealth };

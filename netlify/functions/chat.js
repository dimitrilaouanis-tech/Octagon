// Netlify serverless function — proxies prompts to all AI providers in parallel.
// API keys come from Netlify environment variables:
//   CLAUDE_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, GROK_API_KEY,
//   KIMI_API_KEY, MISTRAL_API_KEY, CHATGPT_API_KEY, PERPLEXITY_API_KEY

const AGENTS = {
  claude: {
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-20250514",
    type: "anthropic",
    envKey: "CLAUDE_API_KEY",
  },
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    type: "openai",
    envKey: "DEEPSEEK_API_KEY",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    model: "gemini-2.0-flash",
    type: "gemini",
    envKey: "GEMINI_API_KEY",
  },
  grok: {
    url: "https://api.x.ai/v1/chat/completions",
    model: "grok-3-mini",
    type: "openai",
    envKey: "GROK_API_KEY",
  },
  kimi: {
    url: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-8k",
    type: "openai",
    envKey: "KIMI_API_KEY",
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest",
    type: "openai",
    envKey: "MISTRAL_API_KEY",
  },
  chatgpt: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    type: "openai",
    envKey: "CHATGPT_API_KEY",
  },
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    model: "sonar",
    type: "openai",
    envKey: "PERPLEXITY_API_KEY",
  },
};

async function callOpenAI(cfg, key, prompt) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} — ${body.substring(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "No response content.";
}

async function callAnthropic(cfg, key, prompt) {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} — ${body.substring(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.map((b) => b.text).join("\n") || "No response content.";
}

async function callGemini(cfg, key, prompt) {
  const url = `${cfg.url}?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} — ${body.substring(0, 200)}`);
  }
  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") ||
    "No response content."
  );
}

async function callSingleAgent(agentId, prompt) {
  const cfg = AGENTS[agentId];
  if (!cfg) return { agent: agentId, ok: false, text: `Unknown agent: ${agentId}` };

  const key = process.env[cfg.envKey];
  if (!key) return { agent: agentId, ok: false, text: `No API key configured (${cfg.envKey})` };

  try {
    let text;
    if (cfg.type === "anthropic") text = await callAnthropic(cfg, key, prompt);
    else if (cfg.type === "gemini") text = await callGemini(cfg, key, prompt);
    else text = await callOpenAI(cfg, key, prompt);
    return { agent: agentId, ok: true, text };
  } catch (err) {
    return { agent: agentId, ok: false, text: err.message };
  }
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { agents, prompt } = payload;

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing prompt" }) };
  }

  if (!Array.isArray(agents) || agents.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing agents array" }) };
  }

  if (agents.length > 8) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Too many agents (max 8)" }) };
  }

  // Call all requested agents in parallel
  const results = await Promise.all(
    agents.map((id) => callSingleAgent(id, prompt.trim()))
  );

  // Return which agents have keys configured (for UI status)
  const configured = {};
  for (const id of Object.keys(AGENTS)) {
    configured[id] = !!process.env[AGENTS[id].envKey];
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ results, configured }),
  };
};

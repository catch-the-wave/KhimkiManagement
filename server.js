const express = require('express');
const fs = require('fs');
const path = require('path');

// Load .env file if present
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  envFile.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key] && val) process.env[key] = val;
  });
  console.log('📄 .env loaded');
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;

// Auto-detect API provider: OpenRouter preferred, Groq as fallback
const useOpenRouter = !!process.env.OPENROUTER_API_KEY;
const API_KEY = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || '';
const API_URL = useOpenRouter
  ? 'https://openrouter.ai/api/v1/chat/completions'
  : 'https://api.groq.com/openai/v1/chat/completions';
const API_NAME = useOpenRouter ? 'OpenRouter' : 'Groq';
let currentModel = process.env.AI_MODEL || (useOpenRouter ? 'google/gemini-2.0-flash-001' : 'llama-3.3-70b-versatile');

// Token limits — mutable, configurable at runtime
let minTokens = parseInt(process.env.MIN_TOKENS, 10) || 100;
let maxTokens = parseInt(process.env.MAX_TOKENS, 10) || 500;

// Models from env: MODELS=id:Name,id2:Name2  — or use defaults
function parseModels(envVar, defaults) {
  const raw = process.env[envVar];
  if (!raw) return defaults;
  return raw.split(',').map(entry => {
    const [id, ...nameParts] = entry.trim().split(':');
    return { id: id.trim(), name: nameParts.join(':').trim() || id.trim() };
  }).filter(m => m.id);
}

const DEFAULT_OPENROUTER_MODELS = [
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
  { id: 'x-ai/grok-3-mini-beta', name: 'Grok 3 Mini' },
  { id: 'x-ai/grok-4.20-beta', name: 'Grok 4.20' },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
];

const DEFAULT_GROQ_MODELS = [
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (fast)' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
];

// Mutable model list — configurable at runtime
let availableModels = useOpenRouter
  ? parseModels('OPENROUTER_MODELS', DEFAULT_OPENROUTER_MODELS)
  : parseModels('GROQ_MODELS', DEFAULT_GROQ_MODELS);

// Load prompt template
let systemPrompt = '';
try {
  systemPrompt = fs.readFileSync(path.join(__dirname, 'prompt.txt'), 'utf-8').trim();
} catch (e) {
  console.error('prompt.txt not found, AI generation disabled');
}

app.use(express.json());
app.use(express.static(__dirname));

// Model management endpoints
app.get('/api/models', (req, res) => {
  res.json({ models: availableModels, current: currentModel });
});

app.post('/api/models', (req, res) => {
  const { model } = req.body;
  if (!model || !availableModels.find(m => m.id === model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  currentModel = model;
  console.log(`\n🔄 Model switched to: ${model}\n`);
  res.json({ current: currentModel });
});

// Runtime settings: tokens range
app.get('/api/settings', (req, res) => {
  res.json({ minTokens, maxTokens, models: availableModels, current: currentModel });
});

app.post('/api/settings', (req, res) => {
  const { min_tokens, max_tokens } = req.body;
  if (min_tokens != null) minTokens = Math.max(50, parseInt(min_tokens, 10) || 100);
  if (max_tokens != null) maxTokens = Math.max(minTokens, parseInt(max_tokens, 10) || 500);
  console.log(`\n⚙️ Tokens updated: ${minTokens}–${maxTokens}\n`);
  res.json({ minTokens, maxTokens });
});

// Runtime model list management: add/remove without redeploy
app.post('/api/models/add', (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ error: 'Model id required' });
  if (availableModels.find(m => m.id === id)) {
    return res.status(409).json({ error: 'Model already exists' });
  }
  availableModels.push({ id, name: name || id });
  console.log(`\n➕ Model added: ${id} (${name || id})\n`);
  res.json({ models: availableModels });
});

app.post('/api/models/remove', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Model id required' });
  const before = availableModels.length;
  availableModels = availableModels.filter(m => m.id !== id);
  if (availableModels.length === before) {
    return res.status(404).json({ error: 'Model not found' });
  }
  if (currentModel === id && availableModels.length > 0) {
    currentModel = availableModels[0].id;
  }
  console.log(`\n➖ Model removed: ${id}\n`);
  res.json({ models: availableModels, current: currentModel });
});

// Sanitize AI response: remove non-Cyrillic/Latin stray characters (Chinese, etc.)
function sanitizeText(text) {
  // Remove CJK characters that sometimes leak from multilingual models
  return text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3100-\u312f]/g, '');
}

// AI text generation endpoint
app.post('/api/generate', async (req, res) => {
  if (!API_KEY || !systemPrompt) {
    return res.status(503).json({ error: 'AI generation not configured' });
  }

  const { name, apt, problems, tone, dest } = req.body;
  if (!name || !apt || !problems || !problems.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const destNames = {
    uk: 'УК «Континент Комфорта»',
    admin: 'Управление ЖКХ администрации г.о. Химки',
    ministry: 'Министерство по содержанию территорий и гос. жилищному надзору МО',
    governor: 'Приёмная губернатора Московской области',
    gis: 'ГИС ЖКХ'
  };

  const userMessage = [
    `ФИО: ${name}`,
    `Квартира: ${apt}`,
    `Тон: ${tone === 'formal' ? 'формальный' : 'неформальный'}`,
    `Получатель: ${destNames[dest] || destNames.uk}`,
    `Проблемы: ${problems.join(', ')}`
  ].join('\n');

  console.log('\n' + '='.repeat(60));
  console.log(`📤 AI REQUEST | Model: ${currentModel}`);
  console.log(`   Name: ${name} | Apt: ${apt} | Tone: ${tone} | Dest: ${dest}`);
  console.log(`   Problems: ${problems.join(', ')}`);
  console.log('-'.repeat(60));

  const startTime = Date.now();

  try {
    const headers = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    };
    if (useOpenRouter) {
      headers['HTTP-Referer'] = 'https://khimki-complaint.app';
      headers['X-Title'] = 'Khimki Complaint Generator';
    }
    const response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: currentModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.9,
        max_tokens: Math.floor(Math.random() * (maxTokens - minTokens + 1)) + minTokens
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`❌ ${API_NAME} API error (${response.status}):`, err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim();
    const elapsed = Date.now() - startTime;
    const usage = data.usage;

    console.log(`📥 AI RESPONSE | ${elapsed}ms | Tokens: ${usage?.prompt_tokens || '?'}→${usage?.completion_tokens || '?'}`);
    console.log(`   Preview: ${(text || '').substring(0, 120)}...`);
    console.log('='.repeat(60) + '\n');

    if (!text) {
      return res.status(502).json({ error: 'Empty AI response' });
    }

    text = sanitizeText(text);

    res.json({ text, model: currentModel });
  } catch (err) {
    console.error(`❌ ${API_NAME} request failed:`, err.message);
    res.status(502).json({ error: 'AI service unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`🤖 Model: ${currentModel}`);
  console.log(`🔑 ${API_NAME} API: ${API_KEY ? 'configured' : 'NOT configured (set OPENROUTER_API_KEY or GROQ_API_KEY)'}`);
  console.log(`📋 Available models: ${availableModels.map(m => m.id).join(', ')}`);
  console.log(`📏 Tokens range: ${minTokens}–${maxTokens}\n`);
});

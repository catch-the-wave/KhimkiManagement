const express = require('express');
const fs = require('fs');
const path = require('path');

// Load .env file if present
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf-8');
  envFile.split('\n').forEach(line => {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  });
} catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || '';
let currentModel = process.env.AI_MODEL || 'google/gemini-2.0-flash-001';

const AVAILABLE_MODELS = [
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
  { id: 'x-ai/grok-3-mini-beta', name: 'Grok 3 Mini' },
  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
];

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
  res.json({ models: AVAILABLE_MODELS, current: currentModel });
});

app.post('/api/models', (req, res) => {
  const { model } = req.body;
  if (!model || !AVAILABLE_MODELS.find(m => m.id === model)) {
    return res.status(400).json({ error: 'Invalid model' });
  }
  currentModel = model;
  console.log(`\n🔄 Model switched to: ${model}\n`);
  res.json({ current: currentModel });
});

// Sanitize AI response: remove non-Cyrillic/Latin stray characters (Chinese, etc.)
function sanitizeText(text) {
  // Remove CJK characters that sometimes leak from multilingual models
  return text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3100-\u312f]/g, '');
}

// AI text generation endpoint
app.post('/api/generate', async (req, res) => {
  if (!OPENROUTER_API_KEY || !systemPrompt) {
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
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://khimki-complaint.app',
        'X-Title': 'Khimki Complaint Generator'
      },
      body: JSON.stringify({
        model: currentModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.9,
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`❌ OpenRouter API error (${response.status}):`, err);
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
    console.error('❌ OpenRouter request failed:', err.message);
    res.status(502).json({ error: 'AI service unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`🤖 Model: ${currentModel}`);
  console.log(`🔑 OpenRouter API: ${OPENROUTER_API_KEY ? 'configured' : 'NOT configured (set OPENROUTER_API_KEY)'}`);
  console.log(`📋 Available models: ${AVAILABLE_MODELS.map(m => m.id).join(', ')}\n`);
});

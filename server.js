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
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-70b-versatile';

// Load prompt template
let systemPrompt = '';
try {
  systemPrompt = fs.readFileSync(path.join(__dirname, 'prompt.txt'), 'utf-8').trim();
} catch (e) {
  console.error('prompt.txt not found, AI generation disabled');
}

app.use(express.json());
app.use(express.static(__dirname));

// AI text generation endpoint
app.post('/api/generate', async (req, res) => {
  if (!GROQ_API_KEY || !systemPrompt) {
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

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
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
      console.error('Groq API error:', response.status, err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      return res.status(502).json({ error: 'Empty AI response' });
    }

    res.json({ text });
  } catch (err) {
    console.error('Groq request failed:', err.message);
    res.status(502).json({ error: 'AI service unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Groq API: ${GROQ_API_KEY ? 'configured' : 'NOT configured (set GROQ_API_KEY)'}`);
});

import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const PORT = 3001;

if (!process.env.OPENAI_API_KEY) {
  throw new Error('Add OPENAI_API_KEY to the .env file first.');
}

const app = express();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 25000,
  maxRetries: 0,
});

app.use(express.json({ limit: '16kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    message: 'Updated Digi server is running',
    port: PORT,
  });
});

app.post('/chat', async (req, res) => {
  const message = req.body?.message;

  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > 500
  ) {
    return res.status(400).json({
      error: 'Send a message between 1 and 500 characters.',
    });
  }

  console.log('Chat request received. Contacting AI...');

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      instructions:
        'You are Digi, a friendly digital companion for Huy. ' +
        'Use simple language and keep replies under 80 words. ' +
        'Reply in Vietnamese when the user writes Vietnamese. ' +
        'You can chat but cannot change game stats, see cameras, ' +
        'or control devices.',
      input: message.trim(),
      max_output_tokens: 250,
      store: false,
    });

    const reply = response.output_text?.trim();

    if (!reply) {
      console.error('AI returned no text.');

      return res.status(502).json({
        error: 'AI returned no text. Please try again.',
      });
    }

    console.log('AI reply received successfully.');
    return res.json({ reply });
  } catch (error) {
    const status = error?.status || 'unknown';
    const code = error?.code || error?.name || 'unknown';

    console.error('AI request failed:', status, code);

    return res.status(502).json({
      error: `AI error: ${status} / ${code}`,
    });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`UPDATED Digi server running on port ${PORT}`);
});

server.on('error', error => {
  console.error('Server startup failed:', error.code);
  process.exit(1);
});
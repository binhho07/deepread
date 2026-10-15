import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, type PromptAnchor } from './prompt.js';

const DEFAULT_MODEL = 'claude-sonnet-5-5';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    'Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set your key, then restart.',
  );
  process.exit(1);
}

const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
const port = Number(process.env.PORT) || 8787;

const client = new Anthropic({ apiKey });
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model });
});

type ChatMessage = { role: 'user' | 'assistant'; content: string };

type ChatBody = {
  docName: string;
  anchor: PromptAnchor;
  messages: ChatMessage[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseChatBody(value: unknown): ChatBody | string {
  if (!isRecord(value)) return 'Request body must be a JSON object.';
  if (typeof value.docName !== 'string' || value.docName.trim() === '') {
    return 'docName must be a non-empty string.';
  }
  if (!isRecord(value.anchor)) return 'anchor must be an object.';
  const anchor = value.anchor;
  if (typeof anchor.page !== 'number' || !Number.isFinite(anchor.page)) {
    return 'anchor.page must be a number.';
  }
  if (typeof anchor.text !== 'string') return 'anchor.text must be a string.';
  if (typeof anchor.contextBefore !== 'string') return 'anchor.contextBefore must be a string.';
  if (typeof anchor.contextAfter !== 'string') return 'anchor.contextAfter must be a string.';
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return 'messages must be a non-empty array.';
  }

  const messages: ChatMessage[] = [];
  for (const message of value.messages) {
    if (!isRecord(message)) return 'Each message must be an object.';
    if (message.role !== 'user' && message.role !== 'assistant') {
      return 'Each message role must be "user" or "assistant".';
    }
    if (typeof message.content !== 'string') return 'Each message content must be a string.';
    messages.push({ role: message.role, content: message.content });
  }

  return {
    docName: value.docName,
    anchor: {
      page: anchor.page,
      text: anchor.text,
      contextBefore: anchor.contextBefore,
      contextAfter: anchor.contextAfter,
    },
    messages,
  };
}

function writeEvent(res: express.Response, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

app.post('/api/chat', async (req, res) => {
  const parsed = parseChatBody(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json({ error: parsed });
    return;
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log('[chat] request', JSON.stringify(parsed, null, 2));
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abort = new AbortController();
  // Node emits `req` 'close' as soon as the POST body is read, while the
  // client is still listening. Abort only when the response connection drops.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  const write = (payload: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    writeEvent(res, payload);
  };

  try {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 4096,
        system: buildSystemPrompt(parsed.docName, parsed.anchor),
        messages: parsed.messages,
      },
      { signal: abort.signal },
    );

    stream.on('error', () => {
      // finalMessage() rejects with the same error.
    });
    stream.on('text', (text) => {
      if (!abort.signal.aborted) write({ type: 'delta', text });
    });

    await stream.finalMessage();

    if (!abort.signal.aborted) {
      write({ type: 'done' });
      res.end();
    }
  } catch (error) {
    if (abort.signal.aborted || res.writableEnded || res.destroyed) return;
    const message = error instanceof Error ? error.message : 'Unknown error';
    write({ type: 'error', message });
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Deepread server listening on http://localhost:${port} (model: ${model})`);
});

# Deepread

A local PDF reader where every highlight gets its own AI chat.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.
3. `npm run dev`

The app is at http://localhost:5173. The API server is at http://localhost:8787. Vite proxies `/api/*` to the server, so the key stays on the server.

## How it works

- Open a PDF. It is stored in the browser (IndexedDB), keyed by a hash of the file bytes.
- Highlight a passage and open a chat. That chat is anchored to the highlight and never shares messages with other chats.
- Questions stream from Claude through a local Express proxy. The browser never sees the API key.
- Minimize, reopen, or delete a chat. Highlights, history, last page, and zoom come back when you reopen the same PDF.
- A 1000-page book only renders pages near the viewport.

PDF viewing and chats land in later milestones. This scaffold serves `/api/health` and a streaming `POST /api/chat`.

## Try the stream

```bash
curl -N -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "docName": "os-concepts.pdf",
    "anchor": {
      "page": 142,
      "text": "A page table maps virtual pages to frames.",
      "contextBefore": "",
      "contextAfter": ""
    },
    "messages": [
      { "role": "user", "content": "What is a frame?" }
    ]
  }'
```

You should see `data: {"type":"delta","text":"..."}` lines, then `data: {"type":"done"}`.

---
title: Thought Companion
emoji: 🎙️
colorFrom: green
colorTo: indigo
sdk: docker
pinned: false
license: mit
app_port: 3334
---

# Thought Companion

A voice-first thinking companion for quick conversations, light research checks, language help, and local browser notes.

## What it does

- Starts a low-latency OpenAI Realtime voice session in the browser.
- Keeps the visible transcript in local browser storage.
- Adds an explicit web search button for current or source-backed questions.
- Turns the conversation into a concise note with one click.
- Supports an optional `ACCESS_CODE` so friends can try the hosted app without seeing your OpenAI API key.

## Local setup

```bash
cp .env.example .env
# Edit .env and add OPENAI_API_KEY.
npm start
```

Open `http://127.0.0.1:3334`.

If your VPN only exposes a local proxy to Terminal, run:

```bash
export HTTPS_PROXY="http://127.0.0.1:15236"
export HTTP_PROXY="http://127.0.0.1:15236"
export ALL_PROXY="http://127.0.0.1:15236"
npm start
```

## Environment variables

- `OPENAI_API_KEY`: required.
- `ACCESS_CODE`: optional shared access code.
- `REALTIME_MODEL`: defaults to `gpt-realtime-2`.
- `TEXT_MODEL`: defaults to `gpt-5.5`.
- `REALTIME_VOICE`: defaults to `marin`.
- `PORT`: defaults to `3334`.
- `HOST`: defaults to `127.0.0.1`; use `0.0.0.0` in hosted containers.

## Safety note

This app is intentionally conservative: the companion is prompted to say when it is unsure, and current/source-backed answers should go through the explicit search button.

Deployment refreshed: 2026-06-12T17:47:40Z.

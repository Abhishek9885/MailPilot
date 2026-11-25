# Portfolio demo script

**Length:** 3-4 minutes  
**Data:** Synthetic preview only. Do not connect a personal mailbox, send a message, or create a Calendar event.

## Before presenting

- Start locally using the root README. Sign in with a dedicated demo account only if the authenticated workspace is needed.
- Verify that the inbox labels itself "Sample data only" or "Sample data remains separate".
- If OAuth or a model provider is unconfigured, skip those live paths. Use the architecture and offline evaluation report.
- Never show `.env`, credentials, tokens, or private browser tabs.

## Talk track

**0:00-0:30 - Problem.** Email scatters decisions and commitments across threads. MailPilot explores retrieval and evidence-backed assistance while keeping mailbox access and external actions explicit. This is synthetic preview data, not Gmail.

**0:30-1:20 - Inbox.** Search and filter the sample messages, then open a message. Hybrid search combines exact keyword matches with semantic retrieval. An answer should cite source messages and abstain when evidence is missing. If no provider is configured, skip generation and open the evaluation report. Do not describe static sample labels as model output.

**1:20-2:10 - Tasks and approvals.** Open Tasks and Approvals. A task stays linked to its source. Consequential operations are exact-payload proposals; an authenticated approval is bound to that snapshot and rechecked immediately before execution. Explain that portions of the preview UI are seeded state. Show contracts and tests; do not trigger real execution.

**2:10-3:00 - Architecture.** Next.js is the interface, Express owns identity, OAuth, Gmail and external effects, and FastAPI owns AI orchestration and retrieval. The AI service never receives Gmail OAuth tokens. Email bodies are evidence, not instructions.

**3:00-3:40 - Evidence.** Hybrid RRF improved top-1 rank on seven synthetic queries, not a live service benchmark. The classifier test has nine examples; the LLM comparison could not run because the provider was unavailable. Those limits are part of the result. Show [evaluation.md](evaluation.md).

Close with the next step: a larger consented, thread-separated evaluation set and recorded live retrieval/model traces with privacy controls.

## Offline commands

These use synthetic fixtures and do not access Gmail or call a model provider:

```powershell
npm run eval:rag
npm run eval:email-classifier
npm run eval:offline
```

The classifier artifact may first need `npm run train:email-classifier`.

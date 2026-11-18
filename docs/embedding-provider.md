# Embedding model and adapter decision

**Decision date:** 2026-11-06  
**Default:** OpenAI `text-embedding-3-small`, 1,536 dimensions  
**Scope:** Python adapter and local input validation only; no indexing, retrieval, or vector persistence is added here.

## Model selection

| Model | Native dimensions | Published MTEB score | Published input price | Trade-off |
|---|---:|---:|---:|---|
| `text-embedding-3-small` | 1,536 | 62.3 | $0.02 / 1M tokens | Lower price, smaller vectors, and the model page's faster/smaller tier. Selected for the first MailPilot index. |
| `text-embedding-3-large` | 3,072 | 64.6 | $0.13 / 1M tokens | Higher benchmark score, at 6.5x the published input price and twice the default vector dimensions. Consider only if a MailPilot retrieval evaluation shows a material quality gain. |

These are provider-published benchmark and price figures, not MailPilot measurements. The small model is the better starting point for a mailbox product where many message chunks may be embedded and indexed. Its lower price and half-sized native vectors reduce embedding and storage cost. The large model remains configurable for a later, measured comparison. MailPilot sends 1,536 dimensions by default even when the large model is selected; configure 3,072 to use its native size. The API also allows shortening third-generation vectors with a `dimensions` parameter, and MailPilot must version any dimension change with the vector index.

The provider describes the small model as its smaller, efficient model. Request latency has not been measured in MailPilot; this adapter sends bounded batches sequentially and applies a bounded timeout/retry policy. Batch size controls request count and burst behavior, while vector dimensions affect response payload and downstream index cost.

## Privacy and deployment

This first adapter calls the hosted OpenAI embeddings endpoint over HTTPS. Email text sent for embedding leaves the MailPilot deployment. OpenAI states that API data is not used to train its models by default, while standard abuse-monitoring logs may contain customer content and are retained for up to 30 days; modified monitoring or zero-retention controls require eligibility and configuration. Do not send mailbox content when the account or deployment policy does not allow this processing. The API key stays in FastAPI configuration, and the adapter never logs input text, vectors, authorization headers, or provider response bodies.

The selection uses the existing OpenAI API key and does not require GPU hardware or a model server. Its trade-off is dependence on outbound provider access, provider limits, and the provider's data controls. The provider-neutral contract allows a self-hosted implementation later if local processing is required; that alternative would add model serving, hardware, patching, and model-quality evaluation work.

## Adapter contract and limits

The interface returns vectors in input order with provider, returned model version, dimensions, provider-reported input/total tokens, and optional estimated cost metadata. The adapter verifies response indexes, count, vector dimensions, finite values, and consistent model version across every batch before returning any result.

OpenAI documents a maximum of 8,192 tokens per input, 2,048 input items per request, and 300,000 combined input tokens per request. MailPilot uses a stricter local bound: at most 32,768 characters and 8,192 tokens per text, 512 texts and 300,000 tokens per `embed` call, and sequential provider batches of at most 64 texts or 100,000 tokens. `cl100k_base` tokenization runs before any provider request, so an invalid item rejects the whole call without partially embedding earlier items.

HTTP 408, 409, 429, 5xx, timeouts, and transport errors use a bounded retry budget with exponential backoff and jitter. A numeric or HTTP-date `Retry-After` is honored only within the configured maximum wait; longer waits return a safe, retryable rate-limit error. Authentication and request-validation errors are not retried. Provider response bodies are not included in errors.

The default vector dimension is 1,536. Store model version, provider, dimension, and source revision with future vectors. A model or dimension change requires a separate vector/index version and full re-embedding; do not compare or mix vectors from incompatible configurations. Optional estimated cost uses `AI_EMBEDDING_INPUT_PRICE_USD_PER_MTOK` with `AI_EMBEDDING_PRICING_VERSION`; no rate is assumed by code.

## Sources

- [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings) and [embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create): model dimensions, token limits, batching, and dimensions parameter.
- [OpenAI `text-embedding-3-small` model page](https://developers.openai.com/api/docs/models/text-embedding-3-small): current published small-model price and model comparison.
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data): training use, abuse-monitoring retention, and eligibility for retention controls.
- [OpenAI `tiktoken` 0.14.0 release](https://github.com/openai/tiktoken/releases/tag/0.14.0): pinned tokenizer dependency used for preflight limits.

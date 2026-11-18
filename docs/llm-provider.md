# LLM provider and model selection

## Provider adapter

OpenAI is the first supported LLM provider. FastAPI code depends on the `LLMProvider` protocol and provider-neutral `LLMRequest` / `LLMResponse` models. The OpenAI Responses HTTP request and response mapping live only in `apps/ai/src/mailpilot_ai/llm/openai_responses.py`; a factory selects the configured adapter. Adding another provider should implement the same interface without leaking provider fields into workflow callers.

The adapter accepts bounded text messages, output-token limits, and an optional provider-neutral JSON Schema output contract. It returns the response text, provider/model IDs, provider request ID, token usage, and optional cost metadata. It uses a per-attempt timeout and a small retry budget for connection timeouts, transient transport failures, HTTP 408/409, rate limits, and server errors. It honors a bounded `Retry-After`; if the provider asks for a longer delay, the adapter returns a retryable rate-limit error with the delay instead of retrying early. Non-retryable credential/request failures and malformed provider responses become safe typed errors without echoing response bodies or prompts. OpenAI requests set `store: false`.

The OpenAI adapter maps the neutral output contract to the Responses API `text.format` JSON Schema form with strict mode. Application code still parses the returned JSON with Pydantic and applies domain validations. OpenAI documents strict structured output support and its JSON Schema subset in the [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

The provider interface makes one text-generation call only. It does not expose tools, streaming, embeddings, or Gmail operations. The `OPENAI_API_KEY` setting is optional for service startup, but provider construction fails with a safe configuration error if the key is missing or blank. The key stays in FastAPI configuration and is never logged or sent to the browser, Express, or Gmail.


## Initial model candidate

As of **2026-10-29**, GPT-6.1 Sol (`gpt-6.1-sol`) is the default evaluation candidate. OpenAI describes it as near the flagship GPT-6 Astra for complex work at a lower cost; the current published input/output rates are $2/$10 per million tokens. GPT-6 Luna (`gpt-6-luna`) is the low-cost, high-volume alternative at $0.10/$0.50 per million tokens. GPT-6 Astra (`gpt-6-astra`) is the higher-capability option at $10/$50 per million tokens. The published model guidance presents Sol as a balance, Luna for cost-sensitive volume, and Astra for demanding reasoning. Verify current model availability and prices before launch in [OpenAI's model catalog](https://developers.openai.com/api/docs/models).

| Candidate | Current published input/output rate per million tokens | Trade-off for MailPilot |
|---|---:|---|
| GPT-6.1 Sol (default candidate) | $2 / $10 | Strong starting point for email extraction and grounded drafting; evaluate quality against latency and cost. |
| GPT-6 Luna | $0.10 / $0.50 | Lowest-cost high-volume candidate; compare extraction completeness and evidence grounding before routing user mail to it. |
| GPT-6 Astra | $10 / $50 | Reserve for workflows where evaluations show a worthwhile quality gain for the much higher token cost. |

These are current published prices, not a quote or an application constant. Change the model with `AI_LLM_MODEL`; no model-specific calls are present outside the adapter. Runtime cost metadata is an **estimate** and is emitted only when `AI_LLM_INPUT_PRICE_USD_PER_MTOK`, `AI_LLM_OUTPUT_PRICE_USD_PER_MTOK`, and a dated `AI_LLM_PRICING_VERSION` are configured. An optional `AI_LLM_CACHED_INPUT_PRICE_USD_PER_MTOK` rate lets the estimate distinguish cached from uncached input tokens. No cost estimate is fabricated when required rates are missing. Provider-reported token usage remains separate from the configured-rate estimate.

Before promoting a model, evaluate it against a frozen set of owned/consented, redacted examples for extraction precision/recall, unsupported claims, evidence grounding, latency, and estimated cost. Include adversarial email instructions and malformed/no-text responses. Keep the selected model and prompt version with every downstream result; changing model alone is not a quality claim.

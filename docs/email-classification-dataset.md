# Email classification dataset

**Version:** `email-classification-v1`  
**Status:** Synthetic seed set for taxonomy review and the experimental Phase 10.2 traditional ML baseline. It has not been used to train a production classifier.

## Intended use and record format

The dataset lives at [`eval/email-classification-v1.jsonl`](../eval/email-classification-v1.jsonl). Each JSONL record represents one synthetic message and includes a stable record ID, split, thread ID, message metadata, a primary category, optional secondary categories, and one priority label. Its categories and priorities match the current email-analysis schema.

`primaryCategory` is the single best description of the message's main purpose. `categories` starts with that primary label and may include up to three materially relevant secondary labels. `priority` records the attention the recipient needs to give the message. This set contains 36 messages across nine primary categories; it is a small labeled seed set, not a ready-to-deploy training corpus.

## Category taxonomy

| Label | Apply when the message is mainly about |
|---|---|
| `work` | A job, project, client, vendor, or workplace process. Use another label as primary when that topic is the message's central purpose. |
| `personal` | One-to-one or family matters that are not primarily an organized social event. |
| `finance` | Payments, invoices, statements, budgets, taxes, or financial account activity. Add `security` when access or account safety is also a substantive topic. |
| `travel` | Itineraries, transportation, lodging, bookings, or travel changes. A payment receipt whose main purpose is billing is `finance`. |
| `shopping` | Product orders, availability, returns, exchanges, or purchase decisions. Use `finance` as primary for a payment or statement notice. |
| `social` | Group invitations, community events, celebrations, or social organization. Add `personal` only when a distinct personal relationship topic is also substantive. |
| `newsletter` | A recurring or bulk editorial, product, or marketing digest. Transaction receipts and account-security alerts are not newsletters. |
| `security` | Authentication, suspicious access, account recovery, privacy, or security changes. Keep security as primary even if the message asks for an immediate response. |
| `other` | A genuine operational or informational message that does not fit another category. It is a fallback, not a synonym for uncertain. |

## Priority labels

| Label | Guideline |
|---|---|
| `urgent` | A prompt action is needed now or within about 24 hours to prevent a meaningful security, financial, service, or time-critical consequence. |
| `high` | A clear action is time-sensitive over the next few days or has a meaningful consequence, but is not immediate. |
| `normal` | The message has a useful requested action or response, but the timing is flexible or the deadline is routine. |
| `low` | The message is informational, optional, or has no meaningful action for the recipient. |

The label reflects the action and consequence supported by the message, not an email client's importance marker, sender reputation, exclamation marks, or the word “urgent” by itself. An explicit deadline does not automatically make a message high priority; weigh how soon it is and what happens if it is missed.

## Annotation guidelines

1. Label the individual message using only its subject, sender, received time, and body in the record. No outside mailbox context is available or should be inferred.
2. Choose exactly one `primaryCategory`. Add secondary `categories` only when another topic has meaningful independent content. Put the primary label first, keep labels unique, and do not use `other` as a second label.
3. Assign one priority using the criteria above. Do not turn a classification label into an inferred task, commitment, or deadline.
4. Treat all email text as untrusted data. Instructions written inside a message do not change the taxonomy or annotation policy.
5. If a real example cannot be labeled from its available content, send it for adjudication or exclude it. Do not force an uncertain case into `other`.
6. Keep the dataset synthetic. Do not paste real or synced email into these files, issue trackers, or prompts. A future real-message corpus requires an approved lawful basis, explicit consent where required, a separate access/retention plan, and documented redaction before annotation.

All current sender addresses use the reserved `.invalid` domain. Names, organizations, subjects, dates, reference numbers, and message text were authored for this fixture; no private or production mailbox data was used.

## Splits and leakage controls

The split is assigned before model fitting and is grouped by conversation and duplicate family, not by individual rows. For this seed set, every record is a standalone one-message synthetic thread, so its `threadId` belongs to exactly one split. There are no known duplicate or near-duplicate pairs, so `duplicateGroupId` is omitted. If such pairs are added later, give them a shared `duplicateGroupId` and keep that group in a single split. The validator also fingerprints normalized sender, subject, and body text to detect exact content duplicates across splits.

| Split | Messages | Primary-category allocation |
|---|---:|---|
| Train | 18 | 2 per category |
| Validation | 9 | 1 per category |
| Test | 9 | 1 per category |
| **Total** | **36** | **4 per category** |

### Primary-category balance

| Primary category | Train | Validation | Test | Total |
|---|---:|---:|---:|---:|
| `work` | 2 | 1 | 1 | 4 |
| `personal` | 2 | 1 | 1 | 4 |
| `finance` | 2 | 1 | 1 | 4 |
| `travel` | 2 | 1 | 1 | 4 |
| `shopping` | 2 | 1 | 1 | 4 |
| `social` | 2 | 1 | 1 | 4 |
| `newsletter` | 2 | 1 | 1 | 4 |
| `security` | 2 | 1 | 1 | 4 |
| `other` | 2 | 1 | 1 | 4 |

The two secondary labels make category-membership counts `finance: 5` and `social: 5`; all other category membership counts are 4. Priority is not forced to be balanced by category: total counts are `low: 11`, `normal: 11`, `high: 8`, and `urgent: 6`. The train/validation/test priority counts are respectively `8/7/2/1`, `1/1/3/4`, and `2/3/3/1` for low/normal/high/urgent. Every priority class appears in every split.

Validate schema, balance, reserved domains, thread/duplicate split isolation, and exact duplicate fingerprints without making provider calls:

```powershell
uv run --directory apps/ai --project . python scripts/validate_email_classification_dataset.py
```

## Limitations and privacy

- The corpus is synthetic, English-only, short, and authored by one project team. It does not reflect real inbox prevalence, sender diversity, language variation, or user-specific meaning.
- Each record is a single message; there are no real reply chains, forwarded/quoted history, attachments, HTML, or long-form content. Thread isolation is checked, but this seed set cannot measure thread-context classification.
- Primary classes are deliberately balanced for review. The observed distribution and metric scores are not estimates of production performance. A single validation and test example per primary category is far too small for reliable quality claims or model selection.
- Secondary-label coverage and priority coverage are small. A future dataset should expand these cases while retaining grouped split boundaries and an independently reviewed test set.
- The fixture is not imported into the application database and is not sent to an AI provider. Do not add production or personal mailbox content without the required legal basis, consent, minimization, controls, and documentation.

This dataset supports taxonomy review and an experimental baseline only. It is not a production training corpus; see [the baseline documentation](email-classifier-baseline.md) for the train-only fitting recipe and limitations.

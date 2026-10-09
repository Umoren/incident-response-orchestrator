# An Agent Is a Control Loop

An agent that "investigates incidents" sounds like intelligence. It is mostly plumbing. This article describes the loop I built for Day 2, then defines its most important part: the anatomy of a tool.

## The loop in one paragraph

The model thinks; the runtime acts; the observation returns. My `runAgent()` sends the conversation and the tool schemas to the model, runs whatever tool the model requests, appends the result, and repeats — until an answer, the step limit (8), or a repeated identical call. Inference is injected as a function, so the loop's rules were tested with stubs before any real model call: six tests cover direct answers, tool success, tool failure, unknown tools, step limits, and repeats.

## The anatomy of a tool

A tool has five parts. Each one exists because the model is an unreliable caller and the loop must survive it.

**1. A name.** The address the model calls. `queryQuoteEvents`, `getErrorRate`, `listDeployments` — verbs the model can distinguish. When my test model asked for `restartService`, the loop answered with the names that actually exist. A name is a contract: call this, and exactly one function runs.

**2. A description.** The only documentation the model reads. It says when to use the tool and what it returns — for example, that `getErrorRate` excludes transport failures from the rate. The description shapes behavior more than any prompt does: the model reaches for tools whose descriptions match its current question.

**3. A parameter schema.** The shape of a valid request: field names, types, and meanings. `queryQuoteEvents` accepts a time window, an order type, a status, and a limit capped at 100. The schema is a promise the runtime keeps on both sides — it tells the model what to send and tells the implementation what to check.

**4. An implementation that validates.** The function body checks its own inputs and throws meaningful errors. `queryQuoteEvents` rejects any order type but `standard` or `priority`; `getErrorRate` returns `null` — not zero — when no request completed, because "no data" is not "no errors." Every tool in this system runs `SELECT` and nothing else, enforced by keeping all three in one short file that can be audited at a glance. Validation is where domain honesty lives: the Day 1 lesson about incomplete traffic cycles is now a SQL expression.

**5. A result envelope.** Every tool returns the same shape: `{ ok: true, output }` or `{ ok: false, error }`. The model never sees a stack trace and never faces a crash — a failed database call arrives as a sentence it can read ("D1 is unreachable"), and the tested behavior is an honest "I cannot conclude" instead of invented numbers.

## Why the anatomy matters more than the model

During this build the configured model was deprecated mid-week and replaced with a one-line config change. Nothing in the loop or the tools cared. Models are interchangeable tenants; the tool contract is the building. An agent's reliability comes from five unglamorous decisions — names, descriptions, schemas, validation, and envelopes — that turn an unreliable caller into a supervised investigator.

The operating principle: **the model proposes, the tool disposes, and the loop guarantees it always ends with the truth about how it ended.**

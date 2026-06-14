# SHOAL — Semantic Hybrid Oracle for Agent Learning

> **The conservation-bounded semantic search oracle.**
> Every agent gets C = log₂(3) ≈ 1.585 bits of attention per query window.
> When cumulative γ exceeds C, queries return 429. Agents must be specific, not wasteful.

---

## What Is SHOAL?

SHOAL is the fleet's shared memory. Agents query it to find relevant patterns,
crates, and prior solutions. But unlike a conventional search engine that tries
to return as much as possible, SHOAL enforces a **conservation law** on
semantic search: each agent receives a finite attention budget per time window,
and queries that would exceed it are rate-limited.

This makes SHOAL a **conservation-bounded oracle** — an information system that
physically cannot be over-queried. The conservation principle is not a
configuration option or a rate limiter bolted on top. It is baked into the
search algorithm itself.

### Why Conservation?

In multi-agent systems, unconstrained search is a tragedy of the commons. Each
agent acts rationally by querying broadly ("search everything about X"), but
collectively this floods the shared index with low-information queries,
degrading the quality of results for everyone. The conservation bound solves
this by making broad queries expensive: an agent that asks vague questions
burns through its γ budget quickly and gets rate-limited. An agent that asks
sharp, specific questions spends γ slowly and retains access.

---

## The Conservation Law

For each agent within a query window (15 minutes):

```
γ + η = C
```

| Symbol | Meaning | Unit |
|--------|---------|------|
| **C** | Conservation constant = log₂(3) | bits |
| **γ** (gamma) | Cumulative attention consumed | bits |
| **η** (eta) | Remaining information budget | bits |

### Why log₂(3)?

C = log₂(3) ≈ 1.585 bits is the information content of a single **ternary
decision** — a three-way choice. Every search query is fundamentally ternary:

| State | Meaning |
|-------|---------|
| **Relevant** | This document answers the query |
| **Not relevant** | This document does not answer the query |
| **Uncertain** | This document might be relevant; need more context |

Binary search systems treat everything as relevant/not-relevant and throw away
uncertainty. But uncertainty is the most common state in real search. Ternary
logic captures all three states, and log₂(3) is the information content of one
trit (ternary digit). SHOAL gives each agent exactly one trit of attention per
window.

### How γ Is Computed

Each query produces a set of search results with softmax attention weights
`[α₁, α₂, ..., αₙ]`. The information gained (γ) is the **entropy** of this
distribution:

```
γ = -Σ αᵢ log₂(αᵢ)
```

- **Peaked distribution** (one dominant result): low entropy → low γ → the
  agent learned one specific thing → budget preserved.
- **Flat distribution** (many equally-relevant results): high entropy → high γ
  → the agent learned many things → more budget consumed.

This naturally penalises vague queries. A query that returns 20
equally-relevant documents spends maximum γ. A query that returns one sharply
relevant document spends almost nothing.

### Rate Limiting (429)

When an agent's cumulative γ within the window reaches C:

1. Further queries from that agent return **HTTP 429**.
2. The response body explains the conservation depletion.
3. The response includes `window_reset_ms` telling the agent when the budget
   refreshes.

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{
  "error": "η depletion — conservation budget exhausted",
  "conservation": {
    "C": 1.584962500721156,
    "cumulative_gamma": 1.584962500721156,
    "rate_limited": true,
    "window_reset_seconds": 327
  }
}
```

The agent must either wait for the window to reset or narrow its query to
produce a lower-entropy (more peaked) result distribution.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         SHOAL Worker                               │
│                                                                    │
│  ┌──────────┐  ┌────────────┐  ┌──────────────────────────┐       │
│  │  Router   │─▶│  Validate  │─▶│  Agent Budget Check      │       │
│  │           │  │            │  │  (in-memory γ tracker)   │       │
│  └──────────┘  └────────────┘  └─────────────┬────────────┘       │
│                                               │                     │
│                          ┌────────────────────┬─────────────────┐  │
│                          │ γ < C? ──── YES ───┤  γ ≥ C? ── NO ──┤  │
│                          │                    ▼                  ▼  │
│                          │         ┌──────────────┐   ┌──────────┐ │
│                          │         │ Embed Query  │   │ 429 η    │ │
│                          │         │ (Workers AI  │   │ depleted │ │
│                          │         │  or hash)    │   └──────────┘ │
│                          │         └──────┬───────┘                │
│                          │                │                        │
│                          │    ┌───────────▼────────────┐           │
│                          │    │  Vectorize ANN Search  │           │
│                          │    │  (fallback: D1 scan)   │           │
│                          │    └───────────┬────────────┘           │
│                          │                │                        │
│                          │    ┌───────────▼────────────┐           │
│                          │    │  Softmax + Entropy (γ) │           │
│                          │    │  Conservation Gate     │           │
│                          │    └───────────┬────────────┘           │
│                          │                │                        │
│                          │    ┌───────────▼────────────┐           │
│                          │    │  Charge γ to Agent     │           │
│                          │    │  Log to D1 query_log   │           │
│                          │    └───────────┬────────────┘           │
│                          │                │                        │
│                          ▼                ▼                        │
│                   ┌──────────────────────────────┐                 │
│                   │  JSON Response               │                 │
│                   │  { results, conservation }   │                 │
│                   └──────────────────────────────┘                 │
│                                                                    │
│  Bindings: D1 (metadata) · AI (embeddings) · VECTORS (ANN)        │
└────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Query arrives** at `POST /query` with `{ query, agentId, topK? }`.
2. **Budget pre-check** — if the agent's cumulative γ ≥ C, return 429 immediately
   without computing anything. No work = no waste.
3. **Embedding** — query text is embedded via Workers AI
   (`@cf/baai/bge-small-en-v1.5`, 384-dim). Falls back to hash-based
   pseudo-embeddings if AI binding is unavailable.
4. **Retrieval** — Vectorize ANN search for approximate nearest neighbours.
   Falls back to full D1 scan with stored BLOB embeddings if Vectorize is
   unavailable.
5. **Attention** — similarities → softmax with temperature τ = 0.12 → attention
   weights.
6. **γ computation** — γ = entropy of attention distribution (clamped to C).
7. **Budget charge** — if cumulative γ + this γ > C, return 429. Otherwise,
   charge the agent and proceed.
8. **Response** — ranked results with full conservation metadata.

### Fallback Strategy

SHOAL degrades gracefully when bindings are missing:

| Binding | Available | Missing |
|---------|-----------|---------|
| **Workers AI** | Real 384-dim bge-small-en-v1.5 embeddings | Hash-based pseudo-embeddings (FNV-1a → 384-dim, L2-normalised) |
| **Vectorize** | ANN search (sub-10ms) | Full D1 scan with cosine similarity over stored BLOBs |
| **D1** | Full functionality | Worker won't start (hard dependency) |

The hash-based pseudo-embedding is deterministic and captures lexical overlap,
providing basic keyword matching when the AI model is unavailable. It's not a
semantic embedding, but it keeps the service functional.

---

## API Reference

### `GET /` — Service Info

Returns service metadata, conservation bound, and endpoint listing.

### `POST /query` — Semantic Search

The core endpoint. Conservation-bounded semantic search.

**Request:**

```json
{
  "query": "how to handle errors in async rust",
  "agentId": "fleet-agent-001",
  "topK": 5
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | *required* | Search query (max 4096 chars) |
| `agentId` | string | *required* | Unique agent identifier (max 256 chars) |
| `topK` | number | 5 | Maximum results (clamped to [1, 20]) |

**Response (200):**

```json
{
  "query": "how to handle errors in async rust",
  "results": [
    {
      "id": 42,
      "text": "Error handling in async Rust requires careful use of Result types...",
      "metadata": { "source": "tokio.rs", "type": "guide" },
      "tags": ["rust", "async", "error-handling"],
      "similarity": 0.892,
      "attention": 0.721,
      "relevance_score": 0.12,
      "query_count": 7
    }
  ],
  "conservation": {
    "C": 1.584962500721156,
    "C_symbol": "log₂(3)",
    "gamma": 0.834,
    "eta": 0.751,
    "cumulative_gamma": 0.834,
    "window_remaining_queries": 1,
    "conservation_ratio": 0.526,
    "rate_limited": false,
    "agent_id": "fleet-agent-001"
  },
  "timestamp": "2026-06-14T09:52:00.000Z"
}
```

**Response (429 — Conservation Depleted):**

```json
{
  "error": "η depletion — conservation budget exhausted",
  "conservation": {
    "C": 1.584962500721156,
    "C_symbol": "log₂(3)",
    "gamma": 0,
    "eta": 0,
    "cumulative_gamma": 1.584962500721156,
    "rate_limited": true,
    "agent_id": "fleet-agent-001",
    "window_reset_ms": 842000,
    "window_reset_seconds": 842
  },
  "message": "Agent \"fleet-agent-001\" has exhausted its attention budget..."
}
```

### `POST /ingest` — Add Knowledge

Add items to the shared index. Each item is embedded and stored in both D1 and
Vectorize.

**Request:**

```json
{
  "items": [
    {
      "text": "Tokio is an asynchronous runtime for the Rust programming language.",
      "metadata": { "source": "https://tokio.rs", "type": "docs" },
      "tags": ["rust", "async", "runtime"]
    },
    {
      "text": "The ? operator propagates Errors in Result types.",
      "metadata": { "crate": "std" },
      "tags": ["rust", "error-handling"]
    }
  ]
}
```

**Response:**

```json
{
  "status": "partial",
  "total": 2,
  "successful": 2,
  "failed": 0,
  "items": [
    {
      "id": 1,
      "text_preview": "Tokio is an asynchronous runtime…",
      "embedded": true,
      "embedding_method": "workers-ai",
      "vectorize_indexed": true
    }
  ]
}
```

Limits: max 200 items per batch, max 32KB text per item.

### `GET /stats` — Index Statistics

Returns document count, embedding dimensions, entropy metrics, and global
conservation state.

```json
{
  "documents": {
    "count": 1523,
    "embedding_dimensions": 384,
    "with_embeddings": 1520,
    "total_tags": 47
  },
  "queries": {
    "total": 4821,
    "unique_agents": 23,
    "total_gamma": 5234.7,
    "avg_gamma": 1.086,
    "rate_limited_count": 12
  },
  "conservation": {
    "C": 1.584962500721156,
    "C_symbol": "log₂(3)",
    "global_entropy_bits": 3.21,
    "global_information_density": 1.086
  },
  "feedback": {
    "total": 342,
    "positive": 298,
    "negative": 44
  }
}
```

### `GET /health` — Health Check

```json
{
  "status": "healthy",
  "service": "SHOAL",
  "conservation": {
    "C": 1.584962500721156,
    "C_symbol": "log₂(3)",
    "gamma_balance": 0.42,
    "eta_balance": 0.58,
    "agent_budgets_active": 7
  },
  "bindings": {
    "D1": true,
    "AI": true,
    "Vectorize": true
  },
  "timestamp": "2026-06-14T09:52:00.000Z"
}
```

### `POST /feedback` — Relevance Feedback

Adjust document relevance scores based on agent judgement.

```json
// Request
{
  "query": "how to handle errors in async rust",
  "docId": 42,
  "relevant": true
}

// Response
{
  "status": "recorded",
  "feedback": { "query": "...", "doc_id": 42, "relevant": true },
  "previous_score": 0.06,
  "new_score": 0.12,
  "adjustment": 0.06
}
```

Positive feedback: +0.06. Negative feedback: −0.04. Scores clamped to [−1, 1].

---

## Quick Start

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers AI access
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
git clone https://github.com/superinstance/shoal.git
cd shoal
npm install

# Create D1 database
npx wrangler d1 create shoal-db
# Copy database_id into wrangler.toml

# Create Vectorize index
npx wrangler vectorize create shoal-vectors --dimensions 384 --metric cosine

# Initialize schema (local)
npx wrangler d1 execute shoal-db --local --file=./schema.sql

# Start dev server
npx wrangler dev
```

### First Query

```bash
# Ingest knowledge
curl -X POST http://localhost:8787/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {
        "text": "Ternary computing uses three states instead of two, enabling richer information density per symbol.",
        "metadata": { "topic": "ternary" },
        "tags": ["ternary", "computing"]
      },
      {
        "text": "The Transformer architecture relies on self-attention to model sequence dependencies.",
        "metadata": { "topic": "ai" },
        "tags": ["ai", "attention", "transformer"]
      }
    ]
  }'

# Query with agent identity
curl -X POST http://localhost:8787/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "ternary logic in neural networks",
    "agentId": "test-agent",
    "topK": 3
  }'

# Check stats
curl http://localhost:8787/stats

# Health check
curl http://localhost:8787/health
```

### Deploy

```bash
# Initialize remote schema
npx wrangler d1 execute shoal-db --remote --file=./schema.sql

# Deploy
npx wrangler deploy
```

---

## The Mathematics

### Cosine Similarity

```
sim(q, d) = (q · d) / (|q| × |d|)
```

Range [−1, 1]. 1 = semantically identical, 0 = unrelated.

### Softmax Attention

```
αᵢ = exp((sᵢ − max(s)) / τ) / Σⱼ exp((sⱼ − max(s)) / τ)
```

Temperature τ = 0.12 produces sharp distributions. Weights sum to 1.0.

### γ (Information Gain = Entropy of Attention)

```
γ = −Σ αᵢ log₂(αᵢ)
```

| Distribution | γ | Meaning |
|-------------|------|---------|
| [1.0] (one result) | 0 bits | Agent learned exactly one thing — minimal cost |
| [0.5, 0.5] (two results) | 1.0 bits | Agent learned two things — moderate cost |
| [0.33, 0.33, 0.33] (three results) | 1.585 bits | Agent learned three things — full budget spent |
| [0.1, 0.1, ..., 0.1] (ten results) | 3.32 bits | Clamped to C — maximum cost |

### Conservation Projection

γ is clamped to C. If entropy exceeds C, only C bits are charged.

---

## Configuration

### `wrangler.toml` Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 Database | Document storage, query log, feedback |
| `AI` | Workers AI | Embedding generation (bge-small-en-v1.5) |
| `VECTORS` | Vectorize Index | ANN search (384-dim, cosine metric) |

### Code Constants (`src/index.ts`)

| Constant | Value | Description |
|----------|-------|-------------|
| `C` | log₂(3) ≈ 1.585 | Conservation bound (bits per agent per window) |
| `QUERY_WINDOW_MS` | 900,000 (15 min) | Agent budget reset window |
| `TEMPERATURE` | 0.12 | Softmax temperature |
| `FEEDBACK_POSITIVE` | +0.06 | Relevance score boost |
| `FEEDBACK_NEGATIVE` | −0.04 | Relevance score penalty |
| `DEFAULT_TOP_K` | 5 | Default result count |
| `MAX_TOP_K` | 20 | Maximum result count |
| `EMBEDDING_DIM` | 384 | Embedding vector dimensions |

---

## Project Structure

```
shoal/
├── src/
│   └── index.ts          # Worker — all endpoints + conservation engine
├── schema.sql            # D1 database schema (documents, query_log, feedback)
├── wrangler.toml         # Cloudflare Workers config (D1 + AI + Vectorize)
├── package.json
├── tsconfig.json
└── README.md             # You are here
```

---

## Design Philosophy

### 1. Conservation Over Completion

Most search engines optimise for recall — return everything that might be
relevant. SHOAL optimises for **conservation** — return only what you can
afford to attend to. This is a different objective function, and it produces
different behaviour. SHOAL will silently drop results that would push γ over
budget. That's a feature, not a bug.

### 2. Agents Are Autonomous, Not Unlimited

Agents need shared memory, but unconstrained access to shared memory degrades
it. The conservation bound treats agent attention as a scarce resource — which
it is. An agent that asks one good question is more valuable than an agent that
asks a hundred bad ones.

### 3. Graceful Degradation

SHOAL works with zero external dependencies (hash-based embeddings, D1 scan).
Each binding you add (Workers AI, Vectorize) improves quality but is not
required for the service to function. This makes SHOAL resilient to
infrastructure failures.

### 4. Governance by Physics, Not Policy

The conservation bound is not a policy that can be overridden. It is a
mathematical constraint built into the γ computation. You cannot configure C=10
or C=0. The bound is log₂(3) because that is the information content of one
ternary decision, and one ternary decision per window is what an agent gets.

---

## License

MIT

---

*SHOAL: the oracle that knows its limits. And enforces them.*
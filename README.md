# SHOAL — The Oracle That Knows Its Limits

> Every search engine wants more attention. SHOAL is the first that refuses it.

---

## The Shoal

Picture a shoal of fish in dark water. A thousand bodies moving as one organism,
each individual sensing the current, the temperature, the faint electrical pulse
of a predator two hundred meters away. The shoal does not try to attend to
everything. It cannot. The shoal survives because it distributes attention
sparingly — a flick of awareness here, a dart of focus there — and never, ever
spends more than it has.

This is not a metaphor. This is a conservation law.

SHOAL is a semantic search oracle built on a single radical principle: **every
query has a finite attention budget, and the engine physically cannot exceed
it.** Not as a configuration option. Not as a rate limit. As a law of physics —
or at least, a law of information.

The budget is C = log₂(3) ≈ 1.585 bits.

Why that number? Because log₂(3) is the information content of a single ternary
decision — a three-way choice. Every search query is, at its heart, a ternary
act: *this is relevant, this is not, or I am uncertain.* Three states. One
trit. log₂(3) bits. The conservation bound says: you get exactly one trit of
attention per query. Spend it wisely.

Most search engines operate on an extractive model: they index everything, attend
to everything, and return everything that matches. The implicit assumption is
that more attention is always better. This is the assumption that Google made,
that Elasticsearch made, that every vector database on the market makes. It is
also the assumption that leads to attention pollution — results pages bloated
with marginally relevant content, users overwhelmed by signal noise, and systems
that consume ever-increasing amounts of compute to rank ever-diminishing returns.

SHOAL flips the model. Instead of asking "how much can we return?", SHOAL asks:
"how much can we afford to attend to?" The answer, always, is C = log₂(3).
When the attention weights of search results sum to more than C, SHOAL does
something no other search engine does: **it refuses.** It scales the weights
down proportionally until they fit within the budget. Some results that would
have been returned are silently dropped. The engine has spent its attention, and
it stops.

---

## The Hermit Crab

SHOAL carries its conservation law like a hermit crab carries its shell. The
shell is not optional. The shell is not a feature. The shell is the organism.
Without the conservation bound, SHOAL is just another vector search engine. With
it, SHOAL becomes something new: a search system with built-in governance.

The hermit crab analogy runs deeper than it first appears. A hermit crab:

1. **Carries its home everywhere.** The conservation bound travels with every
   query — it's computed inline, not enforced by an external rate limiter.

2. **Outgrows its shell and finds a new one.** SHOAL's budget is parameterized.
   The default is C = log₂(3), but a query can specify its own budget (up to a
   system maximum). Different queries need different shells.

3. **Is not the shell.** The crab is the search algorithm — cosine similarity,
   softmax weighting, ranking. The shell is the governance layer that keeps the
   crab alive in a hostile environment (information overload, adversarial
   queries, attention exhaustion).

4. **Lives in the intertidal zone.** SHOAL operates at the boundary between
   local-first AI (your data, your GPU, your embeddings) and cloud-native
   infrastructure (Cloudflare Workers, D1, Workers AI). It exists in the place
   where two worlds meet.

---

## The Conservation Law

In physics, a conservation law states that a particular quantity remains
constant in an isolated system. Energy is conserved. Momentum is conserved.
Angular momentum is conserved. These are not preferences — they are mathematical
necessities that follow from symmetries of the system.

SHOAL's conservation law is analogous. For each query:

```
γ + η = C
```

Where:
- **γ (gamma)** = attention weight consumed = information gained by the search
- **η (eta)** = remaining uncertainty budget = what you *don't* know
- **C** = log₂(3) ≈ 1.585 bits = the conservation constant

Every search allocates γ bits of attention across its results. The sum of
attention weights cannot exceed C. When it threatens to — when the query tries
to attend to too many documents — the conservation gate activates:

1. Compute softmax attention weights for all candidate documents.
2. Sum the weights. If Σ ≤ C: proceed normally, η = C - γ > 0.
3. If Σ > C: **projection** — scale all weights by C/Σ so they fit within budget.
   η drops to zero. The query has spent everything.

This is not the same as truncating results. Truncation throws away information.
Conservation projection *preserves* the relative distribution of attention —
every document gets its proportional share — but compresses the total into the
available budget. The most relevant documents still get the most attention. They
just get less of it than they would in an unbounded system.

### Why This Matters

In an age of AI-generated content, attention is the scarcest resource. A search
engine that can attend to unlimited results will always favor quantity over
quality — it will return 10,000 marginally relevant documents instead of 3
highly relevant ones, because it has no incentive to choose.

SHOAL's conservation bound creates that incentive. When you can only spend 1.585
bits of attention, you choose carefully. You rank aggressively. You prefer the
sharp peak over the broad plateau. And you stop when you're done, rather than
continuing to dredge up increasingly irrelevant results.

---

## Why Ternary? Why log₂(3)?

The choice of C = log₂(3) is not arbitrary. It is the information-theoretic
content of a ternary (base-3) decision. Here's the derivation:

A binary decision (yes/no, relevant/not-relevant) carries log₂(2) = 1 bit of
information. This is the basis of classical binary search and most information
retrieval theory.

But search is not binary. Every result exists in one of three states:

| State | Meaning | Information |
|-------|---------|-------------|
| **Relevant** | This document answers the query | Known-relevant |
| **Not relevant** | This document does not answer the query | Known-irrelevant |
| **Uncertain** | This document might be relevant; we're not sure | Unknown |

This third state — uncertainty — is what classical IR throws away. Binary
systems treat everything as either relevant or not, with no room for genuine
uncertainty. But uncertainty is the most common state in real search: most
documents are *probably not* relevant, but you can't be sure without reading
them.

Ternary logic captures all three states. And the information content of a single
ternary decision is log₂(3) ≈ 1.585 bits. This is why C = log₂(3): SHOAL gives
each query exactly one ternary decision's worth of attention. No more, no less.

This connects SHOAL to the broader trend of **ternary computing** — the idea
that three-valued logic (with explicit uncertainty) is a more natural basis for
AI than binary logic. Ternary neural networks use weights in {-1, 0, +1} rather
than {-1, +1}, allowing the network to express "I don't know" (0) as a first-class
output. SHOAL's conservation bound makes this same insight operational: each
query gets one trit of attention, and the system is forced to decide where to
spend it.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       SHOAL Worker                       │
│                                                          │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────┐ │
│  │  Request  │──▶│   Validate   │──▶│  Embed Query    │ │
│  │  Router   │   │  & Parse     │   │  (Workers AI)   │ │
│  └──────────┘   └──────────────┘   └────────┬────────┘ │
│                                              │          │
│                                              ▼          │
│                                    ┌─────────────────┐  │
│                                    │   D1 Database   │  │
│                                    │  (documents +   │  │
│                                    │   embeddings)   │  │
│                                    └────────┬────────┘  │
│                                              │          │
│                                              ▼          │
│  ┌──────────────────────┐         ┌─────────────────┐  │
│  │  Conservation Gate   │◀────────│  Cosine Sim +   │  │
│  │  Σ attention ≤ C     │         │  Softmax        │  │
│  │  C = log₂(3)         │         └─────────────────┘  │
│  └──────────┬───────────┘                              │
│             │                                           │
│             ▼                                           │
│  ┌──────────────────────┐                              │
│  │  Ranked Results +    │                              │
│  │  Conservation Meta   │                              │
│  │  (γ used, η remaining)│                              │
│  └──────────────────────┘                              │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Query arrives** at `POST /search` with `{ query, topK?, budget? }`.
2. **Validation** — input is checked, topK is clamped to [1, 20], budget is
   clamped to (0, 3C].
3. **Embedding** — the query text is embedded via Workers AI
   (`@cf/baai/bge-small-en-v1.5`), producing a 384-dimensional vector.
4. **Retrieval** — all documents with stored embeddings are fetched from D1.
   Embeddings are stored as Float32Array BLOBs.
5. **Similarity** — cosine similarity is computed between the query embedding
   and every document embedding: cos(a, b) = dot(a,b) / (|a| × |b|).
6. **Attention** — similarities are passed through softmax with temperature
   τ = 0.15, producing attention weights that sum to 1.0.
7. **Conservation gate** — if Σ attention > C, weights are scaled
   proportionally to fit within C. This is the projection step.
8. **Selection** — documents are added to results in rank order until the
   cumulative attention budget is exhausted or topK is reached.
9. **Logging** — the query is logged in the `queries` table with γ (attention
   spent), η (remaining budget), and violation flag.
10. **Response** — ranked results with conservation metadata returned as JSON.

### Feedback Loop

When a user submits relevance feedback (`POST /feedback`), the document's
`relevance_score` is adjusted by ±0.05/0.03. This score acts as a prior that
nudges future rankings — documents with positive feedback get a slight boost in
similarity, those with negative feedback get a slight penalty. Over time, the
shoal learns.

---

## API Reference

### `GET /` — Landing

Returns service metadata, conservation bound details, and endpoint documentation.

```bash
curl https://shoal.your-subdomain.workers.dev/
```

### `POST /search` — Semantic Search

The core endpoint. Semantic search with conservation-bounded attention.

**Request:**

```json
{
  "query": "how to handle errors in async rust",
  "topK": 5,
  "budget": 1.585
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | *required* | Search query (max 4096 chars) |
| `topK` | number | 5 | Maximum results (clamped to [1, 20]) |
| `budget` | number | C ≈ 1.585 | Attention budget for this query (max 3C) |

**Response:**

```json
{
  "query": "how to handle errors in async rust",
  "results": [
    {
      "id": 42,
      "title": "Error Handling in Async Rust",
      "content": "...",
      "source": "rust-lang.org",
      "crate_name": "tokio",
      "doc_type": "guide",
      "similarity": 0.8923,
      "attention_weight": 0.721,
      "relevance_score": 0.15
    }
  ],
  "conservation": {
    "C": 1.584962500721156,
    "gamma_used": 1.203,
    "eta_remaining": 0.382,
    "conservation_ratio": 0.759,
    "bound": "log₂(3)",
    "violated": false
  },
  "query_id": 107
}
```

**Conservation metadata:**

| Field | Meaning |
|-------|---------|
| `C` | The conservation constant (1.585 bits) |
| `gamma_used` | Attention consumed by this query |
| `eta_remaining` | Unused attention budget |
| `conservation_ratio` | γ/C — how much of the budget was spent |
| `bound` | Symbolic representation: "log₂(3)" |
| `violated` | Whether raw attention exceeded C (triggering projection) |

### `POST /ingest` — Document Ingestion

Add documents to the index. Each document is automatically embedded via Workers AI.

**Request:**

```json
{
  "documents": [
    {
      "title": "Getting Started with Tokio",
      "content": "Tokio is an asynchronous runtime for the Rust programming language...",
      "source": "https://tokio.rs/tutorial",
      "crate_name": "tokio",
      "doc_type": "tutorial"
    },
    {
      "title": "Async/Await in Rust",
      "content": "Rust's async/await syntax allows writing asynchronous code that looks like synchronous code...",
      "source": "https://doc.rust-lang.org/async-book",
      "crate_name": "std",
      "doc_type": "book"
    }
  ]
}
```

**Response:**

```json
{
  "status": "ingested",
  "total": 2,
  "successful": 2,
  "failed": 0,
  "documents": [
    { "id": 1, "title": "Getting Started with Tokio", "embedded": true },
    { "id": 2, "title": "Async/Await in Rust", "embedded": true }
  ]
}
```

Limits: max 100 documents per batch. Title max 512 chars. Content max 32KB.

### `GET /documents` — List Documents

Returns up to 200 most recently added documents (without embeddings).

```bash
curl https://shoal.your-subdomain.workers.dev/documents
```

### `GET /stats` — Index Statistics

Global statistics including total conservation budget usage across all queries.

```json
{
  "documents": 1523,
  "queries": 4821,
  "feedback_entries": 342,
  "conservation": {
    "C_per_query": 1.584962500721156,
    "C_symbol": "log₂(3)",
    "total_gamma_spent": 5234.7,
    "total_capacity": 7641.2,
    "global_utilization": 0.685,
    "global_eta_remaining": 2406.5,
    "rejected_queries": 12,
    "avg_gamma_per_query": 1.086
  }
}
```

### `POST /feedback` — Relevance Feedback

Submit feedback on search results to improve future rankings.

**Request:**

```json
{
  "query_id": 107,
  "document_id": 42,
  "relevant": true
}
```

**Response:**

```json
{
  "status": "recorded",
  "feedback": {
    "query_id": 107,
    "document_id": 42,
    "relevant": true
  },
  "new_relevance_score": 0.2,
  "adjustment": 0.05
}
```

Positive feedback adds 0.05 to the document's relevance score. Negative feedback
subtracts 0.03. Scores are clamped to [-1, 1].

### `GET /health` — Health Check

```json
{
  "status": "healthy",
  "service": "SHOAL",
  "conservation_bound": "log₂(3) ≈ 1.584963",
  "timestamp": "2026-06-14T10:30:00.000Z"
}
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- A Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
# Clone the repo
git clone https://github.com/superinstance/shoal.git
cd shoal

# Install dependencies
npm install

# Create the D1 database
npx wrangler d1 create shoal-db
# ^ Copy the database_id into wrangler.toml

# Initialize the schema
npx wrangler d1 execute shoal-db --local --file=./schema.sql

# Start the dev server
npx wrangler dev
```

### First Search

```bash
# Ingest some documents
curl -X POST http://localhost:8787/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {
        "title": "The Ternary Revolution",
        "content": "Ternary computing uses three states instead of two, enabling richer information density per symbol.",
        "doc_type": "article"
      },
      {
        "title": "Attention Is All You Need",
        "content": "The Transformer architecture relies on self-attention mechanisms to model dependencies in sequence data.",
        "doc_type": "paper"
      }
    ]
  }'

# Search with conservation bound
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "ternary logic in neural networks",
    "topK": 3
  }'

# Check stats
curl http://localhost:8787/stats
```

### Deploy

```bash
# Create the remote D1 database
npx wrangler d1 create shoal-db

# Update wrangler.toml with the database_id

# Initialize remote schema
npx wrangler d1 execute shoal-db --remote --file=./schema.sql

# Deploy to the edge
npx wrangler deploy
```

---

## The Three Trends

SHOAL is the first product to combine three emerging trends in computing:

### 1. Ternary Computing

Classical computing is binary: 0 or 1, true or false. Ternary computing uses
three states: -1, 0, +1 (or equivalently: false, unknown, true). This is not a
new idea — the Setun computer (1958) was ternary — but it is newly relevant.
Ternary neural networks (using weights in {-1, 0, +1}) achieve comparable
accuracy to binary networks with 50% fewer parameters, because the zero weight
("I don't know") is informationally rich. SHOAL's conservation bound of C =
log₂(3) bits encodes this ternary insight directly into the search budget.

### 2. Agent Governance

The AI agent community is increasingly concerned with governance: how do we
ensure autonomous agents don't consume unbounded resources, make unbounded
decisions, or take unbounded actions? SHOAL demonstrates one approach: a
conservation law. The engine *cannot* over-attend, not because of an external
rate limiter, but because its information budget is built into the search
algorithm itself. This is governance by physics, not policy. The same principle
could apply to agent memory, agent communication, and agent action selection.

### 3. Local-First AI

The local-first software movement argues that users should own their data,
their compute, and their algorithms. SHOAL runs on Cloudflare's edge, but its
embeddings are generated by an open model (`bge-small-en-v1.5`), its database
is a local SQLite file (via D1), and its conservation law is a mathematical
identity, not a proprietary algorithm. You can fork SHOAL, run it locally with
`wrangler dev`, and have a fully functional semantic search oracle on your
laptop. No API keys to OpenAI. No data leaving your machine. The shoal swims in
your waters.

---

## The Mathematics

### Cosine Similarity

Given query embedding **q** and document embedding **d**:

```
sim(q, d) = (q · d) / (|q| × |d|)
```

This gives a value in [-1, 1], where 1 = identical, 0 = orthogonal, -1 =
opposite.

### Softmax Attention

Given similarities [s₁, s₂, ..., sₙ] and temperature τ:

```
αᵢ = exp((sᵢ - max(s)) / τ) / Σⱼ exp((sⱼ - max(s)) / τ)
```

The attention weights αᵢ sum to 1.0. Lower temperatures produce sharper
distributions (more attention on the top result); higher temperatures produce
flatter distributions (attention spread evenly).

### Conservation Projection

If Σαᵢ > C, scale all weights:

```
αᵢ' = αᵢ × (C / Σαⱼ)
```

After projection, Σαᵢ' = C exactly. The relative ranking is preserved — the
top result is still the top result — but absolute attention values are
compressed.

### Information-Theoretic Justification

The attention weight αᵢ can be interpreted as the probability that document *i*
is the correct answer. Under this interpretation, -log₂(αᵢ) is the surprise
(in bits) of seeing document *i* as the answer. The expected surprise
(entropy) of the search is:

```
H = -Σαᵢ × log₂(αᵢ)
```

The conservation bound C = log₂(3) says: the maximum expected surprise per
query is one ternary decision. This is exactly the entropy of a uniform
distribution over 3 outcomes: H = log₂(3) ≈ 1.585 bits.

---

## Configuration

### Environment Variables

| Variable | Where | Default | Description |
|----------|-------|---------|-------------|
| `DB` | wrangler.toml | — | D1 database binding |
| `AI` | wrangler.toml | — | Workers AI binding |

### Code-Level Constants (in `src/index.ts`)

| Constant | Value | Description |
|----------|-------|-------------|
| `CONSERVATION_C` | log₂(3) ≈ 1.585 | The conservation bound (bits per query) |
| `SOFTMAX_TEMPERATURE` | 0.15 | Temperature for attention softmax |
| `RELEVANCE_BOOST` | 0.05 | Score increase for positive feedback |
| `RELEVANCE_PENALTY` | 0.03 | Score decrease for negative feedback |
| `DEFAULT_TOP_K` | 5 | Default number of results |
| `MAX_TOP_K` | 20 | Maximum results per query |
| `EMBEDDING_DIM` | 384 | Embedding vector dimension |

---

## Project Structure

```
shoal/
├── src/
│   └── index.ts          # Worker entry point — all endpoints
├── schema.sql             # D1 database schema
├── wrangler.toml          # Cloudflare Workers config
├── package.json
├── tsconfig.json
└── README.md              # You are here
```

---

## License

MIT

---

## Acknowledgments

SHOAL stands at the intersection of many ideas:

- **Ternary computing** — Nikolay Brusentsov and the Setun computer (1958)
- **Information theory** — Claude Shannon's mathematical theory of communication (1948)
- **Attention mechanisms** — Bahdanau et al. and Vaswani et al.
- **Local-first software** — Ink & Switch's vision of user sovereignty
- **Conservation laws** — Emmy Noether's theorem connecting symmetry to conservation
- **Cloudflare Workers** — Making edge compute accessible to everyone

The shoal illustration on the landing page is a JSON object. It contains its own
documentation. It is a hermit crab carrying its home.

---

*SHOAL: the oracle that knows its limits. And respects them.*

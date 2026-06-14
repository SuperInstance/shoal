/**
 * SHOAL — Semantic Hybrid Oracle for Agent Learning
 *
 * A conservation-bounded semantic search oracle. Agents query SHOAL to find
 * relevant patterns, crates, and prior solutions. It enforces conservation:
 * queries that would increase η (information waste) beyond the budget
 * C = log₂(3) are rate-limited with HTTP 429.
 *
 * Conservation law per agent:
 *   γ + η = C       where C = log₂(3) ≈ 1.585 bits
 *   γ = cumulative mutual information gained (attention consumed)
 *   η = remaining information budget (uncertainty allowance)
 *
 * When an agent's cumulative γ within a query window exceeds C, all further
 * queries from that agent return 429 until the window resets. This forces
 * agents to be specific and deliberate — SHOAL is an oracle, not a firehose.
 *
 * Architecture:
 *   Workers AI embeddings (@cf/baai/bge-small-en-v1.5, 384-dim)
 *   Vectorize index for approximate nearest neighbour search
 *   D1 for document metadata, query logging, and feedback persistence
 *   Hash-based pseudo-embeddings as fallback when AI binding is unavailable
 *
 * @module shoal
 */

// ═══════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** The conservation bound: C = log₂(3) ≈ 1.585 bits per query window. */
const C = Math.log2(3); // 1.584962500721156

/** Symbolic representation of the bound for API responses. */
const C_SYMBOL = "log₂(3)";

/** Query window in milliseconds (15 minutes). After this, agent budgets reset. */
const QUERY_WINDOW_MS = 15 * 60 * 1000;

/** Softmax temperature for attention weight computation. */
const TEMPERATURE = 0.12;

/** Relevance feedback: score adjustment for positive signal. */
const FEEDBACK_POSITIVE = 0.06;

/** Relevance feedback: score adjustment for negative signal. */
const FEEDBACK_NEGATIVE = 0.04;

/** Default number of results when topK is not specified. */
const DEFAULT_TOP_K = 5;

/** Hard maximum for topK regardless of client request. */
const MAX_TOP_K = 20;

/** Embedding dimensionality for bge-small-en-v1.5. */
const EMBEDDING_DIM = 384;

/** Maximum characters for a query string. */
const MAX_QUERY_LEN = 4096;

/** Maximum characters for document text on ingest. */
const MAX_TEXT_LEN = 32768;

/** Maximum items per ingest batch. */
const MAX_INGEST_BATCH = 200;

/** Maximum characters for tags field. */
const MAX_TAGS_LEN = 1024;

/** Pseudo-embedding hash seed space. */
const HASH_SPACE = 384;

// ═══════════════════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Cloudflare Worker environment bindings. */
export interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORS: VectorizeIndex;
}

/** A document row as stored in D1. */
interface DocumentRow {
  id: number;
  text: string;
  metadata: string; // JSON
  tags: string; // comma-separated
  embedding: ArrayBuffer | null;
  created_at: string;
  query_count: number;
  relevance_score: number;
}

/** A query log row. */
interface QueryLogRow {
  id: number;
  query: string;
  agent_id: string;
  gamma: number;
  eta: number;
  timestamp: string;
}

/** In-flight agent budget state. */
interface AgentBudget {
  agentId: string;
  cumulativeGamma: number;
  windowStart: number;
  queryCount: number;
}

/** POST /query request body (post-validation, topK always set). */
interface QueryRequest {
  query: string;
  topK: number;
  agentId: string;
}

/** POST /ingest request body. */
interface IngestRequest {
  items: IngestItem[];
}

/** Individual ingest item. */
interface IngestItem {
  text: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

/** POST /feedback request body. */
interface FeedbackRequest {
  query: string;
  docId: number;
  relevant: boolean;
}

/** Ranked search result returned to the caller. */
interface SearchResult {
  id: number;
  text: string;
  metadata: Record<string, unknown> | null;
  tags: string[];
  similarity: number;
  attention: number;
  relevance_score: number;
  query_count: number;
}

/** Conservation metadata attached to every query response. */
interface ConservationMeta {
  C: number;
  C_symbol: string;
  gamma: number;
  eta: number;
  cumulative_gamma: number;
  window_remaining_queries: number | null;
  conservation_ratio: number;
  rate_limited: boolean;
  agent_id: string;
}

/** Full /query response. */
interface QueryResponse {
  query: string;
  results: SearchResult[];
  conservation: ConservationMeta;
  timestamp: string;
}

/** /stats response. */
interface StatsResponse {
  documents: {
    count: number;
    embedding_dimensions: number;
    with_embeddings: number;
    total_tags: number;
  };
  queries: {
    total: number;
    unique_agents: number;
    total_gamma: number;
    avg_gamma: number;
    rate_limited_count: number;
  };
  conservation: {
    C: number;
    C_symbol: string;
    global_entropy_bits: number;
    global_information_density: number;
  };
  feedback: {
    total: number;
    positive: number;
    negative: number;
  };
}

/** /health response. */
interface HealthResponse {
  status: "healthy" | "degraded";
  service: string;
  conservation: {
    C: number;
    C_symbol: string;
    gamma_balance: number; // 0..1 — how much of global C has been spent
    eta_balance: number; // 1 - gamma_balance
    agent_budgets_active: number;
  };
  bindings: {
    D1: boolean;
    AI: boolean;
    Vectorize: boolean;
  };
  timestamp: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  IN-MEMORY AGENT BUDGET TRACKER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tracks per-agent cumulative γ within a sliding query window.
 *
 * Keyed by agentId. Each entry records the window start time, cumulative γ
 * spent, and number of queries made. When the window expires (now -
 * windowStart > QUERY_WINDOW_MS), the budget resets.
 *
 * In a real multi-isolate deployment this would live in Durable Objects or KV,
 * but for a single Worker isolate it works perfectly. D1 provides durability
 * for the query log; this map provides sub-millisecond rate-limit decisions.
 */
const agentBudgets = new Map<string, AgentBudget>();

/**
 * Maximum number of agent entries before we garbage-collect old ones.
 * Prevents unbounded memory growth from transient agents.
 */
const MAX_AGENT_ENTRIES = 10_000;

/**
 * Get or create the budget record for an agent. Expires stale windows.
 */
function getAgentBudget(agentId: string, now: number): AgentBudget {
  let budget = agentBudgets.get(agentId);

  if (!budget) {
    budget = {
      agentId,
      cumulativeGamma: 0,
      windowStart: now,
      queryCount: 0,
    };
    // GC if map has grown too large — evict oldest entries.
    if (agentBudgets.size >= MAX_AGENT_ENTRIES) {
      gcAgentBudgets(now);
    }
    agentBudgets.set(agentId, budget);
    return budget;
  }

  // Check if the window has expired — if so, reset.
  if (now - budget.windowStart > QUERY_WINDOW_MS) {
    budget.cumulativeGamma = 0;
    budget.queryCount = 0;
    budget.windowStart = now;
  }

  return budget;
}

/**
 * Garbage-collect stale agent budget entries.
 * Removes entries whose windows have expired.
 */
function gcAgentBudgets(now: number): void {
  for (const [id, budget] of agentBudgets) {
    if (now - budget.windowStart > QUERY_WINDOW_MS * 2) {
      agentBudgets.delete(id);
    }
  }
}

/**
 * Record γ spent by an agent and check whether they are within budget.
 * Returns { allowed, cumulativeGamma, eta }.
 */
function chargeAgent(
  agentId: string,
  gamma: number,
  now: number,
): { allowed: boolean; cumulativeGamma: number; eta: number } {
  const budget = getAgentBudget(agentId, now);
  const prospectiveGamma = budget.cumulativeGamma + gamma;

  if (prospectiveGamma > C) {
    return {
      allowed: false,
      cumulativeGamma: budget.cumulativeGamma,
      eta: Math.max(0, C - budget.cumulativeGamma),
    };
  }

  budget.cumulativeGamma = prospectiveGamma;
  budget.queryCount++;
  return {
    allowed: true,
    cumulativeGamma: budget.cumulativeGamma,
    eta: Math.max(0, C - budget.cumulativeGamma),
  };
}

/**
 * Estimate γ (information gained) from a set of search results.
 *
 * Uses the entropy of the attention distribution as the information measure:
 *   γ = -Σ αᵢ log₂(αᵢ)
 *
 * A peaked distribution (one dominant result) has low entropy → low γ →
 * the agent learned one specific thing and retains budget.
 *
 * A flat distribution (many equally-relevant results) has high entropy →
 * high γ → the agent learned many things and spends more budget.
 *
 * This naturally penalises vague queries that return many similar results.
 */
function computeGamma(attentionWeights: number[]): number {
  if (attentionWeights.length === 0) return 0;
  let entropy = 0;
  for (const w of attentionWeights) {
    if (w > 0) {
      entropy -= w * Math.log2(w);
    }
  }
  // Clamp to [0, C] — even if entropy exceeds C, we never charge more.
  return Math.min(entropy, C);
}

// ═══════════════════════════════════════════════════════════════════════════
//  EMBEDDING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a Float32Array to a Uint8Array for D1 BLOB storage.
 */
function f32ToBytes(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Convert a D1 BLOB (ArrayBuffer) back to a Float32Array.
 */
function bytesToF32(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf);
}

/**
 * Convert a number[] (from Vectorize or AI) to Float32Array.
 */
function arrayToF32(arr: number[]): Float32Array {
  return Float32Array.from(arr);
}

/**
 * Generate a deterministic hash-based pseudo-embedding.
 *
 * Used as a fallback when the Workers AI binding is unavailable or fails.
 * Produces a 384-dimensional vector by hashing the input text with multiple
 * seeds and normalising the result. This is NOT a real semantic embedding,
 * but it provides consistent vector representations that capture lexical
 * overlap — sufficient for basic keyword matching.
 *
 * Algorithm: FNV-1a hash with rotating seed → uniform [0,1] → normalise to unit length.
 */
function pseudoEmbed(text: string, dim: number = EMBEDDING_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);

  // For each token, hash it into multiple dimensions.
  for (const token of tokens) {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619); // FNV prime
    }
    // Spread each token across 4 dimensions.
    for (let s = 0; s < 4; s++) {
      const idx = (Math.abs(hash) + s * 97) % dim;
      const contribution = ((hash >>> (s * 7)) & 0xff) / 255 - 0.5;
      vec[idx] += contribution;
      // Re-mix hash.
      hash = Math.imul(hash ^ (hash >>> 13), 16777619);
    }
  }

  // L2-normalise.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }

  return vec;
}

/**
 * Embed text using Workers AI, with hash-based fallback.
 *
 * Attempts the real embedding model first. If the AI binding is missing,
 * the model errors, or the response is malformed, falls back to
 * pseudoEmbed(). Returns { vector, method } so callers know which
 * embedding strategy was used.
 */
async function embed(
  text: string,
  ai: Ai | undefined,
): Promise<{ vector: Float32Array; method: "workers-ai" | "hash-fallback" }> {
  // Try Workers AI first.
  if (ai) {
    try {
      const result = await ai.run("@cf/baai/bge-small-en-v1.5", { text });
      const data = (result as { data?: number[][] }).data;
      if (data && data.length > 0 && data[0].length === EMBEDDING_DIM) {
        return { vector: arrayToF32(data[0]), method: "workers-ai" };
      }
      // Malformed response — log and fall through to fallback.
      console.warn("SHOAL: Workers AI returned unexpected shape, falling back");
    } catch (err) {
      console.warn("SHOAL: Workers AI embedding failed, using hash fallback:", err);
    }
  }

  return { vector: pseudoEmbed(text), method: "hash-fallback" };
}

// ═══════════════════════════════════════════════════════════════════════════
//  VECTOR MATH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cosine similarity between two Float32Array vectors.
 * Range: [-1, 1] where 1 = identical, 0 = orthogonal, -1 = opposite.
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Softmax with temperature over an array of similarity scores.
 * Returns weights summing to 1.0.
 */
function softmax(scores: number[], temp: number): number[] {
  if (scores.length === 0) return [];
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - max) / temp));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (sum === 0) return scores.map(() => 1 / scores.length);
  return exps.map((e) => e / sum);
}

// ═══════════════════════════════════════════════════════════════════════════
//  VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate and normalise a POST /query request body.
 * Returns the parsed request or null if invalid.
 */
function parseQueryRequest(body: unknown): QueryRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.query !== "string" || obj.query.trim().length === 0) return null;
  if (obj.query.length > MAX_QUERY_LEN) return null;
  if (typeof obj.agentId !== "string" || obj.agentId.trim().length === 0) return null;
  if (obj.agentId.length > 256) return null;
  const topK =
    typeof obj.topK === "number" && Number.isInteger(obj.topK) && obj.topK > 0
      ? Math.min(obj.topK, MAX_TOP_K)
      : DEFAULT_TOP_K;
  return {
    query: obj.query.trim(),
    topK,
    agentId: obj.agentId.trim(),
  };
}

/**
 * Validate and normalise a POST /ingest request body.
 */
function parseIngestRequest(body: unknown): IngestRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.items) || obj.items.length === 0) return null;
  if (obj.items.length > MAX_INGEST_BATCH) return null;

  const items: IngestItem[] = [];
  for (const raw of obj.items) {
    if (typeof raw !== "object" || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== "string" || item.text.trim().length === 0) return null;
    if (item.text.length > MAX_TEXT_LEN) return null;
    const metadata =
      typeof item.metadata === "object" && item.metadata !== null
        ? (item.metadata as Record<string, unknown>)
        : undefined;
    let tags: string[] | undefined;
    if (Array.isArray(item.tags)) {
      tags = item.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
      if (tags.length > 50) return null; // sane limit
    }
    items.push({
      text: item.text.trim(),
      metadata,
      tags,
    });
  }
  return { items };
}

/**
 * Validate a POST /feedback request body.
 */
function parseFeedbackRequest(body: unknown): FeedbackRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.query !== "string" || obj.query.trim().length === 0) return null;
  if (typeof obj.docId !== "number" || !Number.isInteger(obj.docId)) return null;
  if (typeof obj.relevant !== "boolean") return null;
  return { query: obj.query.trim(), docId: obj.docId, relevant: obj.relevant };
}

// ═══════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function corsify(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

function json(data: unknown, status = 200): Response {
  return corsify(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function errorJSON(msg: string, status: number, extra?: Record<string, unknown>): Response {
  return json({ error: msg, ...extra }, status);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT: GET / (LANDING)
// ═══════════════════════════════════════════════════════════════════════════

function handleLanding(): Response {
  return json({
    name: "SHOAL",
    full_name: "Semantic Hybrid Oracle for Agent Learning",
    tagline: "Conservation-bounded semantic search oracle",
    description:
      "Agents query SHOAL to find patterns, crates, and prior solutions. " +
      "Each agent gets an attention budget of C = log₂(3) ≈ 1.585 bits per window. " +
      "When cumulative γ exceeds C, queries return 429. " +
      "SHOAL enforces conservation: agents must be specific, not wasteful.",
    conservation_bound: {
      C,
      symbol: C_SYMBOL,
      bits: C.toFixed(6),
      meaning: "Maximum cumulative attention (γ) per agent per query window",
      window_seconds: QUERY_WINDOW_MS / 1000,
    },
    endpoints: {
      "POST /query": {
        description: "Semantic search with conservation-bounded attention",
        body: { query: "string (required)", topK: "number (default 5, max 20)", agentId: "string (required)" },
        returns: "Ranked results with conservation metadata (γ, η, cumulative budget)",
        rate_limit: "429 when cumulative γ for agentId exceeds C in the query window",
      },
      "POST /ingest": {
        description: "Add knowledge items with automatic embedding and Vectorize indexing",
        body: { items: "[{ text: string, metadata?: object, tags?: string[] }]" },
        returns: "Ingestion summary with embedding method and document IDs",
        limit: `${MAX_INGEST_BATCH} items per batch`,
      },
      "GET /stats": {
        description: "Index statistics: vector count, dimensions, entropy metrics",
        returns: "Document/query/feedback counts, conservation entropy, information density",
      },
      "GET /health": {
        description: "Health check with γ/η balance metrics",
        returns: "Service status, binding health, agent budget activity",
      },
      "POST /feedback": {
        description: "Relevance feedback: adjust document scores based on agent judgement",
        body: { query: "string", docId: "number", relevant: "boolean" },
        returns: "Feedback confirmation with adjusted relevance score",
      },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT: POST /query
// ═══════════════════════════════════════════════════════════════════════════

async function handleQuery(req: Request, env: Env): Promise<Response> {
  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJSON("Invalid JSON body", 400);
  }

  const parsed = parseQueryRequest(body);
  if (!parsed) {
    return errorJSON(
      "Invalid request. Required: { query: string (non-empty, ≤4096 chars), agentId: string, topK?: number }",
      400,
    );
  }

  const { query: queryText, topK, agentId } = parsed;
  const now = Date.now();

  // ── Pre-flight: check agent budget BEFORE embedding ──────────────────
  // If the agent is already over budget, we refuse immediately without
  // doing any work. This is the conservation gate.
  const budget = getAgentBudget(agentId, now);
  if (budget.cumulativeGamma >= C) {
    // Log the rejected query.
    await env.DB.prepare(
      "INSERT INTO query_log (query, agent_id, gamma, eta) VALUES (?, ?, 0, 0)",
    )
      .bind(queryText, agentId)
      .run();

    const etaMs = QUERY_WINDOW_MS - (now - budget.windowStart);

    return json(
      {
        error: "η depletion — conservation budget exhausted",
        conservation: {
          C,
          C_symbol: C_SYMBOL,
          gamma: 0,
          eta: 0,
          cumulative_gamma: budget.cumulativeGamma,
          conservation_ratio: budget.cumulativeGamma / C,
          rate_limited: true,
          agent_id: agentId,
          window_reset_ms: Math.max(0, etaMs),
          window_reset_seconds: Math.max(0, Math.ceil(etaMs / 1000)),
        },
        message:
          `Agent "${agentId}" has exhausted its attention budget (γ = ${budget.cumulativeGamma.toFixed(6)} ≥ C = ${C.toFixed(6)}). ` +
          `Queries will be rate-limited until the window resets. Narrow your query or wait.`,
      },
      429,
    );
  }

  // ── Embed the query ──────────────────────────────────────────────────
  const { vector: queryVec, method: embedMethod } = await embed(queryText, env.AI);

  // ── Retrieve candidate documents ─────────────────────────────────────
  // Strategy: Try Vectorize first for ANN retrieval. If unavailable or
  // empty, fall back to full D1 scan with stored embeddings.

  let candidates: { id: number; similarity: number }[] = [];

  // Attempt Vectorize ANN search.
  if (env.VECTORS) {
    try {
      const fetchK = topK * 3;
      const vecResult = await env.VECTORS.query(Array.from(queryVec), { topK: fetchK });
      if (vecResult.matches && vecResult.matches.length > 0) {
        candidates = vecResult.matches.map((m: VectorizeMatch) => ({
          id: typeof m.id === 'number' ? m.id : parseInt(String(m.id), 10),
          similarity: m.score,
        }));
      }
    } catch (err) {
      console.warn("SHOAL: Vectorize query failed, falling back to D1 scan:", err);
    }
  }

  // Fallback: full scan via D1 stored embeddings.
  if (candidates.length === 0) {
    const rows = await env.DB.prepare(
      "SELECT id, embedding FROM documents WHERE embedding IS NOT NULL",
    ).all<{ id: number; embedding: ArrayBuffer }>();

    if (rows.results && rows.results.length > 0) {
      const scored: { id: number; similarity: number }[] = [];
      for (const row of rows.results) {
        const docVec = bytesToF32(row.embedding);
        scored.push({ id: row.id, similarity: cosineSim(queryVec, docVec) });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      candidates = scored.slice(0, Math.min(topK * 3, scored.length));
    }
  }

  // ── No candidates — return empty results ─────────────────────────────
  if (candidates.length === 0) {
    // Charge zero γ — no information was gained.
    const logResult = await env.DB.prepare(
      "INSERT INTO query_log (query, agent_id, gamma, eta) VALUES (?, ?, 0, ?)",
    )
      .bind(queryText, agentId, C)
      .run();

    return json({
      query: queryText,
      results: [],
      conservation: {
        C,
        C_symbol: C_SYMBOL,
        gamma: 0,
        eta: C,
        cumulative_gamma: budget.cumulativeGamma,
        window_remaining_queries: null,
        conservation_ratio: budget.cumulativeGamma / C,
        rate_limited: false,
        agent_id: agentId,
      },
      timestamp: new Date().toISOString(),
      message: "No documents indexed. Use POST /ingest to add knowledge.",
    });
  }

  // ── Fetch full document rows for candidates ──────────────────────────
  const candidateIds = candidates.map((c) => c.id);
  const placeholders = candidateIds.map(() => "?").join(",");
  const docRows = await env.DB.prepare(
    `SELECT id, text, metadata, tags, query_count, relevance_score FROM documents WHERE id IN (${placeholders})`,
  )
    .bind(...candidateIds)
    .all<DocumentRow>();

  // Build a map for quick lookup.
  const docMap = new Map<number, DocumentRow>();
  if (docRows.results) {
    for (const row of docRows.results) {
      docMap.set(row.id, row);
    }
  }

  // ── Compute attention weights ────────────────────────────────────────
  // If we used D1 fallback, we already have similarities. If Vectorize,
  // we use the Vectorize scores as similarity.
  const sims = candidates.map((c) => c.similarity);
  const attentionWeights = softmax(sims, TEMPERATURE);

  // ── Conservation gate: compute γ from attention entropy ──────────────
  const gamma = computeGamma(attentionWeights.slice(0, topK));

  // ── Charge the agent's budget ────────────────────────────────────────
  const charge = chargeAgent(agentId, gamma, now);

  if (!charge.allowed) {
    // The γ from this query would push the agent over budget.
    // We still log the query, but return 429.
    await env.DB.prepare(
      "INSERT INTO query_log (query, agent_id, gamma, eta) VALUES (?, ?, 0, ?)",
    )
      .bind(queryText, agentId, 0)
      .run();

    const etaMs = QUERY_WINDOW_MS - (now - budget.windowStart);

    return json(
      {
        error: "η depletion — this query's γ would exceed conservation budget",
        conservation: {
          C,
          C_symbol: C_SYMBOL,
          gamma,
          eta: 0,
          cumulative_gamma: charge.cumulativeGamma,
          conservation_ratio: charge.cumulativeGamma / C,
          rate_limited: true,
          agent_id: agentId,
          window_reset_ms: Math.max(0, etaMs),
          window_reset_seconds: Math.max(0, Math.ceil(etaMs / 1000)),
        },
        message:
          `Query γ (${gamma.toFixed(6)}) would bring cumulative γ to ` +
          `${(charge.cumulativeGamma + gamma).toFixed(6)}, exceeding C = ${C.toFixed(6)}. ` +
          `Wait for window reset or refine your query.`,
      },
      429,
    );
  }

  // ── Build result list ────────────────────────────────────────────────
  const results: SearchResult[] = [];
  const topCandidates = candidates.slice(0, topK);

  for (let i = 0; i < topCandidates.length; i++) {
    const cand = topCandidates[i];
    const doc = docMap.get(cand.id);
    if (!doc) continue;

    let metadata: Record<string, unknown> | null = null;
    try {
      metadata = doc.metadata ? JSON.parse(doc.metadata) : null;
    } catch {
      metadata = null;
    }

    const tags = doc.tags ? doc.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

    results.push({
      id: doc.id,
      text: doc.text,
      metadata,
      tags,
      similarity: cand.similarity,
      attention: attentionWeights[i] ?? 0,
      relevance_score: doc.relevance_score ?? 0,
      query_count: doc.query_count ?? 0,
    });
  }

  // ── Update query_count for returned documents ────────────────────────
  // Fire-and-forget — don't block the response.
  const resultIds = results.map((r) => r.id);
  if (resultIds.length > 0) {
    const updatePlaceholders = resultIds.map(() => "?").join(",");
    env.DB.prepare(
      `UPDATE documents SET query_count = query_count + 1 WHERE id IN (${updatePlaceholders})`,
    )
      .bind(...resultIds)
      .run()
      .catch(() => {}); // swallow — non-critical
  }

  // ── Log the query ────────────────────────────────────────────────────
  const logResult = await env.DB.prepare(
    "INSERT INTO query_log (query, agent_id, gamma, eta) VALUES (?, ?, ?, ?)",
  )
    .bind(queryText, agentId, gamma, charge.eta)
    .run();

  // ── Build response ───────────────────────────────────────────────────
  const windowRemainingMs = QUERY_WINDOW_MS - (now - budget.windowStart);
  const avgGammaPerQuery = budget.queryCount > 0 ? budget.cumulativeGamma / budget.queryCount : 0;
  const windowRemainingQueries = avgGammaPerQuery > 0 ? Math.floor(charge.eta / avgGammaPerQuery) : null;

  const response: QueryResponse = {
    query: queryText,
    results,
    conservation: {
      C,
      C_symbol: C_SYMBOL,
      gamma,
      eta: charge.eta,
      cumulative_gamma: charge.cumulativeGamma,
      window_remaining_queries: windowRemainingQueries,
      conservation_ratio: charge.cumulativeGamma / C,
      rate_limited: false,
      agent_id: agentId,
    },
    timestamp: new Date().toISOString(),
  };

  return json(response);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT: POST /ingest
// ═══════════════════════════════════════════════════════════════════════════

async function handleIngest(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJSON("Invalid JSON body", 400);
  }

  const parsed = parseIngestRequest(body);
  if (!parsed) {
    return errorJSON(
      `Invalid request. Expected: { items: [{ text: string (≤${MAX_TEXT_LEN} chars), metadata?: object, tags?: string[] }] } (max ${MAX_INGEST_BATCH} items)`,
      400,
    );
  }

  const ingested: {
    id: number;
    text_preview: string;
    embedded: boolean;
    embedding_method: string;
    vectorize_indexed: boolean;
  }[] = [];
  let failed = 0;

  for (const item of parsed.items) {
    try {
      // Embed the text.
      const { vector, method } = await embed(item.text, env.AI);
      const embeddingBlob = f32ToBytes(vector);
      const metadataJSON = item.metadata ? JSON.stringify(item.metadata) : "{}";
      const tagsStr = item.tags ? item.tags.join(", ") : "";

      // Insert into D1.
      const result = await env.DB.prepare(
        "INSERT INTO documents (text, metadata, tags, embedding) VALUES (?, ?, ?, ?)",
      )
        .bind(item.text, metadataJSON, tagsStr, embeddingBlob)
        .run();

      const docId = result.meta.last_row_id ?? 0;

      // Also insert into Vectorize if available.
      let vectorizeIndexed = false;
      if (env.VECTORS) {
        try {
          await env.VECTORS.upsert([
            {
              id: String(docId),
              values: Array.from(vector),
              metadata: {
                text_preview: item.text.slice(0, 200),
                tags: tagsStr,
              },
            },
          ]);
          vectorizeIndexed = true;
        } catch (err) {
          console.warn("SHOAL: Vectorize upsert failed for doc", docId, err);
        }
      }

      ingested.push({
        id: docId,
        text_preview: item.text.slice(0, 120) + (item.text.length > 120 ? "…" : ""),
        embedded: true,
        embedding_method: method,
        vectorize_indexed: vectorizeIndexed,
      });
    } catch (err) {
      console.error("SHOAL: Ingestion failed for item:", item.text.slice(0, 80), err);
      failed++;
    }
  }

  return json({
    status: ingested.length > 0 ? "partial" : "failed",
    total: parsed.items.length,
    successful: ingested.length,
    failed,
    items: ingested,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT: GET /stats
// ═══════════════════════════════════════════════════════════════════════════

async function handleStats(env: Env): Promise<Response> {
  // Document statistics.
  const docCountRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM documents",
  ).first<{ count: number }>();

  const withEmbeddingsRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM documents WHERE embedding IS NOT NULL",
  ).first<{ count: number }>();

  // Collect all unique tags.
  const tagsRow = await env.DB.prepare(
    "SELECT tags FROM documents WHERE tags IS NOT NULL AND tags != ''",
  ).all<{ tags: string }>();
  const allTags = new Set<string>();
  if (tagsRow.results) {
    for (const row of tagsRow.results) {
      row.tags.split(",").forEach((t) => {
        const trimmed = t.trim();
        if (trimmed) allTags.add(trimmed);
      });
    }
  }

  // Query statistics.
  const queryCountRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM query_log",
  ).first<{ count: number }>();

  const uniqueAgentsRow = await env.DB.prepare(
    "SELECT COUNT(DISTINCT agent_id) as count FROM query_log",
  ).first<{ count: number }>();

  const totalGammaRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(gamma), 0) as total FROM query_log",
  ).first<{ total: number }>();

  const avgGammaRow = await env.DB.prepare(
    "SELECT COALESCE(AVG(gamma), 0) as avg FROM query_log WHERE gamma > 0",
  ).first<{ avg: number }>();

  // Count queries that were rate-limited (gamma = 0 but logged).
  const rateLimitedRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM query_log WHERE gamma = 0 AND eta = 0",
  ).first<{ count: number }>();

  // Feedback statistics.
  const feedbackCountRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM feedback",
  ).first<{ count: number }>();

  const positiveFeedbackRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM feedback WHERE relevant = 1",
  ).first<{ count: number }>();

  const negativeFeedbackRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM feedback WHERE relevant = 0",
  ).first<{ count: number }>();

  const docCount = docCountRow?.count ?? 0;
  const queryCount = queryCountRow?.count ?? 0;
  const totalGamma = totalGammaRow?.total ?? 0;
  const withEmbeddings = withEmbeddingsRow?.count ?? 0;

  // Entropy metrics.
  // Global entropy: H = -Σ pᵢ log₂(pᵢ) where pᵢ = query_countᵢ / total_queries
  // This measures how "spread" the attention is across documents.
  let globalEntropyBits = 0;
  if (docCount > 0 && queryCount > 0) {
    const queryCountRows = await env.DB.prepare(
      "SELECT query_count FROM documents WHERE query_count > 0",
    ).all<{ query_count: number }>();
    if (queryCountRows.results) {
      const totalQueries = queryCountRows.results.reduce((sum, r) => sum + r.query_count, 0);
      if (totalQueries > 0) {
        for (const row of queryCountRows.results) {
          const p = row.query_count / totalQueries;
          if (p > 0) globalEntropyBits -= p * Math.log2(p);
        }
      }
    }
  }

  // Information density: how much γ per query on average.
  const avgGamma = avgGammaRow?.avg ?? 0;
  const infoDensity = queryCount > 0 ? totalGamma / queryCount : 0;

  const response: StatsResponse = {
    documents: {
      count: docCount,
      embedding_dimensions: EMBEDDING_DIM,
      with_embeddings: withEmbeddings,
      total_tags: allTags.size,
    },
    queries: {
      total: queryCount,
      unique_agents: uniqueAgentsRow?.count ?? 0,
      total_gamma: totalGamma,
      avg_gamma: avgGamma,
      rate_limited_count: rateLimitedRow?.count ?? 0,
    },
    conservation: {
      C,
      C_symbol: C_SYMBOL,
      global_entropy_bits: globalEntropyBits,
      global_information_density: infoDensity,
    },
    feedback: {
      total: feedbackCountRow?.count ?? 0,
      positive: positiveFeedbackRow?.count ?? 0,
      negative: negativeFeedbackRow?.count ?? 0,
    },
  };

  return json(response);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT: GET /health
// ═══════════════════════════════════════════════════════════════════════════

async function handleHealth(env: Env): Promise<Response> {
  const bindings = {
    D1: false,
    AI: false,
    Vectorize: false,
  };

  let status: "healthy" | "degraded" = "healthy";

  // Check D1.
  try {
    await env.DB.prepare("SELECT 1").first();
    bindings.D1 = true;
  } catch {
    status = "degraded";
  }

  // Check AI binding presence (can't easily test without running a model).
  bindings.AI = !!env.AI;

  // Check Vectorize binding.
  bindings.Vectorize = !!env.VECTORS;

  if (!bindings.D1) status = "degraded";

  // Compute γ/η balance from active agent budgets.
  let totalCumulativeGamma = 0;
  let activeBudgets = 0;
  const now = Date.now();
  for (const [, budget] of agentBudgets) {
    if (now - budget.windowStart <= QUERY_WINDOW_MS) {
      totalCumulativeGamma += budget.cumulativeGamma;
      activeBudgets++;
    }
  }
  const avgGamma = activeBudgets > 0 ? totalCumulativeGamma / activeBudgets : 0;
  const gammaBalance = Math.min(1, avgGamma / C);
  const etaBalance = 1 - gammaBalance;

  const response: HealthResponse = {
    status,
    service: "SHOAL",
    conservation: {
      C,
      C_symbol: C_SYMBOL,
      gamma_balance: gammaBalance,
      eta_balance: etaBalance,
      agent_budgets_active: activeBudgets,
    },
    bindings,
    timestamp: new Date().toISOString(),
  };

  return json(response, status === "healthy" ? 200 : 503);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ENDPOINT: POST /feedback
// ═══════════════════════════════════════════════════════════════════════════

async function handleFeedback(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJSON("Invalid JSON body", 400);
  }

  const parsed = parseFeedbackRequest(body);
  if (!parsed) {
    return errorJSON(
      "Invalid request. Expected: { query: string, docId: number, relevant: boolean }",
      400,
    );
  }

  const { query, docId, relevant } = parsed;

  // Verify document exists.
  const doc = await env.DB.prepare(
    "SELECT id, relevance_score FROM documents WHERE id = ?",
  )
    .bind(docId)
    .first<{ id: number; relevance_score: number }>();

  if (!doc) {
    return errorJSON(`Document ${docId} not found`, 404);
  }

  // Record feedback.
  await env.DB.prepare(
    "INSERT INTO feedback (query, doc_id, relevant) VALUES (?, ?, ?)",
  )
    .bind(query, docId, relevant ? 1 : 0)
    .run();

  // Adjust relevance score.
  const adjustment = relevant ? FEEDBACK_POSITIVE : -FEEDBACK_NEGATIVE;
  const newScore = Math.max(-1, Math.min(1, (doc.relevance_score ?? 0) + adjustment));

  await env.DB.prepare("UPDATE documents SET relevance_score = ? WHERE id = ?")
    .bind(newScore, docId)
    .run();

  return json({
    status: "recorded",
    feedback: {
      query,
      doc_id: docId,
      relevant,
    },
    previous_score: doc.relevance_score ?? 0,
    new_score: newScore,
    adjustment,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════════════════

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const path = url.pathname;

    // CORS preflight.
    if (method === "OPTIONS") {
      return corsify(new Response(null, { status: 204 }));
    }

    try {
      // ── Route table ─────────────────────────────────────────────
      if (path === "/" && method === "GET") return handleLanding();

      if (path === "/query" && method === "POST") return await handleQuery(req, env);

      if (path === "/ingest" && method === "POST") return await handleIngest(req, env);

      if (path === "/stats" && method === "GET") return await handleStats(env);

      if (path === "/health" && method === "GET") return await handleHealth(env);

      if (path === "/feedback" && method === "POST") return await handleFeedback(req, env);

      // ── 404 ──────────────────────────────────────────────────────
      return errorJSON("Not found", 404, {
        path,
        method,
        available_endpoints: [
          "GET /",
          "POST /query",
          "POST /ingest",
          "GET /stats",
          "GET /health",
          "POST /feedback",
        ],
      });
    } catch (err) {
      console.error("SHOAL: Unhandled error:", err);
      return errorJSON("Internal server error", 500, {
        detail: String(err),
        service: "SHOAL",
      });
    }
  },
};

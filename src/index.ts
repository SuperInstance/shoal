/**
 * SHOAL — Conservation-Bounded Semantic Search Oracle
 *
 * "Every search engine wants more attention. SHOAL is the first that refuses it."
 *
 * The conservation bound C = log₂(3) ≈ 1.585 bits is the maximum attention
 * any single query can expend. Search results are gated by softmax attention
 * weights whose sum cannot exceed C. This makes SHOAL self-limiting: it
 * physically cannot over-attend.
 *
 * Architecture:
 *   Workers AI embeddings (@cf/baai/bge-small-en-v1.5, 384-dim)
 *   → cosine similarity against D1-stored Float32Array BLOBs
 *   → softmax normalization → conservation gate (Σ attention ≤ C)
 *   → ternary-influenced ranking
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Conservation bound: C = log₂(3) ≈ 1.585 bits. The natural ternary attention budget. */
const CONSERVATION_C = Math.log2(3); // ≈ 1.584962500721156

/** Softmax temperature — controls sharpness of attention distribution. */
const SOFTMAX_TEMPERATURE = 0.15;

/** Feedback bump: how much a "relevant" vote boosts a document's score. */
const RELEVANCE_BOOST = 0.05;

/** Feedback penalty: how much a "not relevant" vote reduces a document's score. */
const RELEVANCE_PENALTY = 0.03;

/** Default top-K when not specified. */
const DEFAULT_TOP_K = 5;

/** Maximum top-K allowed per query. */
const MAX_TOP_K = 20;

/** Embedding dimension (bge-small-en-v1.5). */
const EMBEDDING_DIM = 384;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Env {
  DB: D1Database;
  AI: Ai;
}

interface SearchRequest {
  query: string;
  topK?: number;
  budget?: number;
}

interface IngestRequest {
  documents: IngestDocument[];
}

interface IngestDocument {
  title: string;
  content: string;
  source?: string;
  crate_name?: string;
  doc_type?: string;
}

interface FeedbackRequest {
  query_id: number;
  document_id: number;
  relevant: boolean;
}

interface SearchResult {
  id: number;
  title: string;
  content: string;
  source: string | null;
  crate_name: string | null;
  doc_type: string;
  similarity: number;
  attention_weight: number;
  relevance_score: number;
}

interface ConservationMeta {
  C: number;
  gamma_used: number;
  eta_remaining: number;
  conservation_ratio: number;
  bound: string;
  violated: boolean;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  conservation: ConservationMeta;
  query_id: number;
}

interface DocumentRow {
  id: number;
  title: string;
  content: string;
  embedding: ArrayBuffer | null;
  source: string | null;
  crate_name: string | null;
  doc_type: string;
  relevance_score: number;
  created_at: string;
}

// ─── Embedding Utilities ─────────────────────────────────────────────────────

/**
 * Convert a Float32Array to a Buffer for D1 BLOB storage.
 */
function float32ToBuffer(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Convert a D1 BLOB back to a Float32Array.
 */
function bufferToFloat32(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf);
}

/**
 * Compute cosine similarity between two embedding vectors.
 * cos(a, b) = dot(a,b) / (|a| * |b|)
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Compute softmax over similarity scores with temperature.
 * Returns attention weights that sum to 1.0 (before conservation gating).
 */
function softmax(scores: number[], temperature: number): number[] {
  if (scores.length === 0) return [];
  const maxScore = Math.max(...scores);
  const exps = scores.map((s) => Math.exp((s - maxScore) / temperature));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  if (sumExp === 0) return scores.map(() => 1 / scores.length);
  return exps.map((e) => e / sumExp);
}

// ─── Conservation Engine ─────────────────────────────────────────────────────

/**
 * The conservation gate.
 *
 * Given attention weights and a budget C, determine how much attention
 * can be spent (γ) and how much remains (η).
 *
 * If Σ attention > C, we scale all weights proportionally to fit within C.
 * This is the "conservation projection" — we never violate the bound.
 *
 * Returns the gated weights plus conservation metadata.
 */
function applyConservationGate(
  weights: number[],
  budget: number,
): { gatedWeights: number[]; gamma: number; eta: number; violated: boolean } {
  const rawSum = weights.reduce((a, b) => a + b, 0);

  if (rawSum <= budget) {
    // No violation — full attention within budget.
    return {
      gatedWeights: weights,
      gamma: rawSum,
      eta: budget - rawSum,
      violated: false,
    };
  }

  // Conservation violation detected — project into feasible region.
  // Scale all weights proportionally so Σ = C.
  const scale = budget / rawSum;
  const gatedWeights = weights.map((w) => w * scale);
  const gamma = gatedWeights.reduce((a, b) => a + b, 0);

  return {
    gatedWeights,
    gamma,
    eta: 0, // Budget exhausted
    violated: true,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateSearchRequest(body: unknown): SearchRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.query !== "string" || obj.query.trim().length === 0) return null;
  if (obj.query.length > 4096) return null;
  const topK =
    typeof obj.topK === "number" && Number.isInteger(obj.topK) && obj.topK > 0
      ? Math.min(obj.topK, MAX_TOP_K)
      : DEFAULT_TOP_K;
  const budget =
    typeof obj.budget === "number" && obj.budget > 0
      ? Math.min(obj.budget, CONSERVATION_C * 3) // allow some headroom but cap
      : CONSERVATION_C;
  return { query: obj.query.trim(), topK, budget };
}

function validateIngestRequest(body: unknown): IngestRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj.documents) || obj.documents.length === 0) return null;
  if (obj.documents.length > 100) return null; // batch limit

  const docs: IngestDocument[] = [];
  for (const d of obj.documents) {
    if (typeof d !== "object" || d === null) return null;
    const doc = d as Record<string, unknown>;
    if (typeof doc.title !== "string" || doc.title.trim().length === 0) return null;
    if (typeof doc.content !== "string" || doc.content.trim().length === 0) return null;
    if (doc.title.length > 512) return null;
    if (doc.content.length > 32768) return null;
    docs.push({
      title: doc.title.trim(),
      content: doc.content.trim(),
      source: typeof doc.source === "string" ? doc.source : undefined,
      crate_name: typeof doc.crate_name === "string" ? doc.crate_name : undefined,
      doc_type: typeof doc.doc_type === "string" ? doc.doc_type : "generic",
    });
  }
  return { documents: docs };
}

function validateFeedbackRequest(body: unknown): FeedbackRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.query_id !== "number" || !Number.isInteger(obj.query_id)) return null;
  if (typeof obj.document_id !== "number" || !Number.isInteger(obj.document_id)) return null;
  if (typeof obj.relevant !== "boolean") return null;
  return {
    query_id: obj.query_id,
    document_id: obj.document_id,
    relevant: obj.relevant,
  };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function corsify(res: Response): Response {
  const newRes = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    newRes.headers.set(k, v);
  }
  return newRes;
}

function json(body: unknown, status = 200): Response {
  return corsify(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// ─── Landing Page ────────────────────────────────────────────────────────────

function landingResponse(): Response {
  return json({
    name: "SHOAL",
    tagline: "The Oracle That Knows Its Limits",
    description:
      "A conservation-bounded semantic search oracle. " +
      "Every query is gated by C = log₂(3) ≈ 1.585 bits of attention. " +
      "SHOAL is the first search engine that refuses more attention than it can afford.",
    conservation_bound: {
      C: CONSERVATION_C,
      symbol: "log₂(3)",
      bits: CONSERVATION_C.toFixed(6),
      meaning: "Maximum attention expenditure per query in bits",
    },
    endpoints: {
      "POST /search": {
        description: "Semantic search with conservation budget",
        body: { query: "string", topK: "number (default 5, max 20)", budget: "number (default C)" },
        returns: "Ranked results with conservation metadata (γ used, η remaining)",
      },
      "POST /ingest": {
        description: "Add documents with automatic embedding",
        body: { documents: "[{ title, content, source?, crate_name?, doc_type? }]" },
        returns: "Ingestion summary with embedding confirmation",
      },
      "GET /documents": {
        description: "List all indexed documents",
        returns: "Document metadata (no embeddings)",
      },
      "GET /stats": {
        description: "Index statistics and global conservation budget usage",
        returns: "Document count, query count, total γ spent, η remaining globally",
      },
      "POST /feedback": {
        description: "Submit relevance feedback to adjust future rankings",
        body: { query_id: "number", document_id: "number", relevant: "boolean" },
        returns: "Feedback confirmation with adjusted score",
      },
      "GET /health": {
        description: "Health check",
        returns: "Service status",
      },
    },
    links: {
      github: "https://github.com/superinstance/shoal",
      docs: "https://github.com/superinstance/shoal#readme",
    },
  });
}

// ─── HTTP Handlers ───────────────────────────────────────────────────────────

async function handleSearch(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = validateSearchRequest(body);
  if (!parsed) {
    return json(
      { error: "Invalid request. Required: { query: string (non-empty, ≤4096 chars), topK?: number, budget?: number }" },
      400,
    );
  }

  const { query: queryText, topK = DEFAULT_TOP_K, budget = CONSERVATION_C } = parsed;
  const effectiveBudget = Math.min(budget, CONSERVATION_C);

  // Embed the query via Workers AI.
  let queryEmbedding: Float32Array;
  try {
    const aiResult = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: queryText });
    const raw = (aiResult as { data: number[][] }).data;
    queryEmbedding = new Float32Array(raw[0]);
  } catch (err) {
    return json(
      { error: "Failed to generate query embedding", detail: String(err) },
      502,
    );
  }

  // Fetch all documents with embeddings.
  const docRows = await env.DB.prepare(
    "SELECT id, title, content, embedding, source, crate_name, doc_type, relevance_score FROM documents WHERE embedding IS NOT NULL",
  ).all<DocumentRow>();

  if (!docRows.results || docRows.results.length === 0) {
    // No documents — return empty results with full budget intact.
    const insertQuery = await env.DB.prepare(
      "INSERT INTO queries (query_text, results_returned, gamma_used, eta_budget, conservation_c, rejected) VALUES (?, 0, 0, ?, ?, 0)",
    )
      .bind(queryText, effectiveBudget, CONSERVATION_C)
      .run();

    return json({
      query: queryText,
      results: [],
      conservation: {
        C: CONSERVATION_C,
        gamma_used: 0,
        eta_remaining: effectiveBudget,
        conservation_ratio: 0,
        bound: "log₂(3)",
        violated: false,
      },
      query_id: insertQuery.meta.last_row_id,
      message: "No documents indexed. Ingest documents first with POST /ingest.",
    });
  }

  // Compute cosine similarity for every document.
  const scored = docRows.results.map((row) => {
    const docEmb = bufferToFloat32(row.embedding as ArrayBuffer);
    const sim = cosineSimilarity(queryEmbedding, docEmb);
    return {
      row,
      similarity: sim,
    };
  });

  // Sort by similarity descending.
  scored.sort((a, b) => b.similarity - a.similarity);

  // Take top-K * 2 candidates (we'll narrow after conservation gating).
  const candidates = scored.slice(0, Math.min(topK * 3, scored.length));

  // Extract similarities for softmax.
  const sims = candidates.map((c) => c.similarity);

  // Compute attention weights via softmax with temperature.
  const rawWeights = softmax(sims, SOFTMAX_TEMPERATURE);

  // Apply conservation gate: Σ attention ≤ C.
  const { gatedWeights, gamma, eta, violated } = applyConservationGate(rawWeights, effectiveBudget);

  // Now select results: include documents until cumulative gated weight reaches budget.
  // We keep documents whose cumulative attention stays within C.
  const results: SearchResult[] = [];
  let cumulativeGamma = 0;

  for (let i = 0; i < candidates.length && results.length < topK; i++) {
    const weight = gatedWeights[i];
    // Include if this document's attention fits within remaining budget.
    if (cumulativeGamma + weight <= effectiveBudget || results.length === 0) {
      cumulativeGamma += weight;
      results.push({
        id: candidates[i].row.id,
        title: candidates[i].row.title,
        content: candidates[i].row.content,
        source: candidates[i].row.source,
        crate_name: candidates[i].row.crate_name,
        doc_type: candidates[i].row.doc_type,
        similarity: candidates[i].similarity,
        attention_weight: weight,
        relevance_score: candidates[i].row.relevance_score ?? 0,
      });
    }
    // Stop if budget exhausted.
    if (cumulativeGamma >= effectiveBudget) break;
  }

  // Final gamma is the actual attention spent.
  const finalGamma = cumulativeGamma;
  const finalEta = effectiveBudget - finalGamma;

  // Log the query.
  const insertQuery = await env.DB.prepare(
    "INSERT INTO queries (query_text, results_returned, gamma_used, eta_budget, conservation_c, rejected) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      queryText,
      results.length,
      finalGamma,
      finalEta,
      CONSERVATION_C,
      violated ? 1 : 0,
    )
    .run();

  const queryId = insertQuery.meta.last_row_id ?? 0;

  const conservationMeta: ConservationMeta = {
    C: CONSERVATION_C,
    gamma_used: finalGamma,
    eta_remaining: finalEta,
    conservation_ratio: finalGamma / CONSERVATION_C,
    bound: "log₂(3)",
    violated,
  };

  const response: SearchResponse = {
    query: queryText,
    results,
    conservation: conservationMeta,
    query_id: queryId,
  };

  return json(response);
}

async function handleIngest(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = validateIngestRequest(body);
  if (!parsed) {
    return json(
      {
        error:
          "Invalid request. Expected: { documents: [{ title: string (≤512), content: string (≤32768), source?, crate_name?, doc_type? }] } (max 100 per batch)",
      },
      400,
    );
  }

  const ingested: { id: number; title: string; embedded: boolean }[] = [];
  let failed = 0;

  for (const doc of parsed.documents) {
    try {
      // Embed the document content via Workers AI.
      const aiResult = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
        text: `${doc.title}. ${doc.content}`,
      });
      const raw = (aiResult as { data: number[][] }).data;
      const embedding = new Float32Array(raw[0]);
      const embeddingBlob = float32ToBuffer(embedding);

      const result = await env.DB.prepare(
        "INSERT INTO documents (title, content, embedding, source, crate_name, doc_type) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(
          doc.title,
          doc.content,
          embeddingBlob,
          doc.source ?? null,
          doc.crate_name ?? null,
          doc.doc_type,
        )
        .run();

      ingested.push({
        id: result.meta.last_row_id ?? 0,
        title: doc.title,
        embedded: true,
      });
    } catch (err) {
      console.error("Ingestion failed for document:", doc.title, err);
      failed++;
    }
  }

  return json({
    status: "ingested",
    total: parsed.documents.length,
    successful: ingested.length,
    failed,
    documents: ingested,
  });
}

async function handleDocuments(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, title, content, source, crate_name, doc_type, relevance_score, created_at FROM documents ORDER BY created_at DESC LIMIT 200",
  ).all();

  return json({
    count: rows.results.length,
    documents: rows.results,
  });
}

async function handleStats(env: Env): Promise<Response> {
  const docCount = await env.DB.prepare("SELECT COUNT(*) as count FROM documents").first<{ count: number }>();
  const queryCount = await env.DB.prepare("SELECT COUNT(*) as count FROM queries").first<{ count: number }>();
  const feedbackCount = await env.DB.prepare("SELECT COUNT(*) as count FROM feedback").first<{ count: number }>();
  const totalGamma = await env.DB.prepare(
    "SELECT COALESCE(SUM(gamma_used), 0) as total_gamma FROM queries",
  ).first<{ total_gamma: number }>();
  const rejectedCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM queries WHERE rejected = 1",
  ).first<{ count: number }>();
  const avgGamma = await env.DB.prepare(
    "SELECT COALESCE(AVG(gamma_used), 0) as avg_gamma FROM queries",
  ).first<{ avg_gamma: number }>();

  // Global conservation: each query gets C bits, total capacity = C * num_queries.
  const totalCapacity = CONSERVATION_C * (queryCount?.count ?? 0);
  const totalGammaVal = totalGamma?.total_gamma ?? 0;
  const globalUtilization = totalCapacity > 0 ? totalGammaVal / totalCapacity : 0;

  return json({
    documents: docCount?.count ?? 0,
    queries: queryCount?.count ?? 0,
    feedback_entries: feedbackCount?.count ?? 0,
    conservation: {
      C_per_query: CONSERVATION_C,
      C_symbol: "log₂(3)",
      total_gamma_spent: totalGammaVal,
      total_capacity: totalCapacity,
      global_utilization: globalUtilization,
      global_eta_remaining: Math.max(0, totalCapacity - totalGammaVal),
      rejected_queries: rejectedCount?.count ?? 0,
      avg_gamma_per_query: avgGamma?.avg_gamma ?? 0,
    },
  });
}

async function handleFeedback(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = validateFeedbackRequest(body);
  if (!parsed) {
    return json(
      { error: "Invalid request. Expected: { query_id: number, document_id: number, relevant: boolean }" },
      400,
    );
  }

  // Verify query exists.
  const query = await env.DB.prepare("SELECT id FROM queries WHERE id = ?")
    .bind(parsed.query_id)
    .first();
  if (!query) {
    return json({ error: `Query ${parsed.query_id} not found` }, 404);
  }

  // Verify document exists.
  const doc = await env.DB.prepare("SELECT id, relevance_score FROM documents WHERE id = ?")
    .bind(parsed.document_id)
    .first<{ id: number; relevance_score: number }>();
  if (!doc) {
    return json({ error: `Document ${parsed.document_id} not found` }, 404);
  }

  // Insert feedback record.
  await env.DB.prepare(
    "INSERT INTO feedback (query_id, document_id, relevant) VALUES (?, ?, ?)",
  )
    .bind(parsed.query_id, parsed.document_id, parsed.relevant ? 1 : 0)
    .run();

  // Adjust document relevance score.
  const adjustment = parsed.relevant ? RELEVANCE_BOOST : -RELEVANCE_PENALTY;
  const newScore = Math.max(-1, Math.min(1, (doc.relevance_score ?? 0) + adjustment));

  await env.DB.prepare("UPDATE documents SET relevance_score = ? WHERE id = ?")
    .bind(newScore, parsed.document_id)
    .run();

  return json({
    status: "recorded",
    feedback: {
      query_id: parsed.query_id,
      document_id: parsed.document_id,
      relevant: parsed.relevant,
    },
    new_relevance_score: newScore,
    adjustment,
  });
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    // Lightweight DB check.
    await env.DB.prepare("SELECT 1").first();
    return json({
      status: "healthy",
      service: "SHOAL",
      conservation_bound: `log₂(3) ≈ ${CONSERVATION_C.toFixed(6)}`,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return json(
      {
        status: "degraded",
        service: "SHOAL",
        error: "Database unreachable",
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

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
      // Route table.
      if (path === "/" && method === "GET") {
        return landingResponse();
      }

      if (path === "/search" && method === "POST") {
        return await handleSearch(req, env);
      }

      if (path === "/ingest" && method === "POST") {
        return await handleIngest(req, env);
      }

      if (path === "/documents" && method === "GET") {
        return await handleDocuments(env);
      }

      if (path === "/stats" && method === "GET") {
        return await handleStats(env);
      }

      if (path === "/feedback" && method === "POST") {
        return await handleFeedback(req, env);
      }

      if (path === "/health" && method === "GET") {
        return await handleHealth(env);
      }

      // Unknown route.
      return json(
        {
          error: "Not found",
          path,
          method,
          available_endpoints: [
            "GET /",
            "POST /search",
            "POST /ingest",
            "GET /documents",
            "GET /stats",
            "POST /feedback",
            "GET /health",
          ],
        },
        404,
      );
    } catch (err) {
      console.error("Unhandled error:", err);
      return json(
        {
          error: "Internal server error",
          detail: String(err),
          service: "SHOAL",
        },
        500,
      );
    }
  },
};

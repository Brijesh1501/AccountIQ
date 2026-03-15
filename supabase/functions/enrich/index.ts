// AccountIQ — Supabase Edge Function
// File: supabase/functions/enrich/index.ts
//
// Deploy with:
//   supabase functions deploy enrich --no-verify-jwt
//
// Set secret:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Rate limit: max requests per user per hour
const RATE_LIMIT = 100;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 3600_000 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }

  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

const AI_SYSTEM_PROMPT = `You are an expert account research AI for a B2B CRM platform. Analyse the given company website and return ONLY a valid JSON object — no markdown, no explanation, no preamble.

══ ACCOUNT TYPE DEFINITIONS ══
Use exactly one of these five values for accountType:

Enterprise:
- Large organisation with generally 1000+ employees, OR
- Smaller organisation (~45+ employees) with multiple business lines / sub-businesses
- Can be tech or non-tech depending on technology usage
- Operates across multiple domains or business lines
- ROI / profitability driven mainly from OFFLINE channels (physical stores, distributors, direct sales) rather than online platforms
- Organisations that sell ONLY their own products via website/app = Enterprise (not Consumer Portal)
- Examples: tejasnetworks.com, wforwoman.com, wildcraft.com

ISV (Independent Software Vendor):
- Owns and develops its own software product or platform
- Provides software solutions to businesses or individual users
- Revenue through subscriptions, licensing, or trial-to-paid models
- Must be INDEPENDENT — not acquired by another organisation
- Core business = software product sales, NOT services

Consumer Portal:
- ROI is primarily dependent on online platforms
- Operates as a MARKETPLACE connecting buyers and sellers
- Revenue from online transactions, commissions, advertisements, or platform usage
- If an organisation ONLY sells its own products through its website/app → classify as Enterprise, NOT Consumer Portal
- Example of NOT a Consumer Portal: wildcraft.com (sells own products only)

Agency / Service Company:
- Primarily provides IT SERVICES (not products): IT consulting, application development, website development, digital transformation
- Does NOT own a proprietary software product as its primary offering
- Any NON-IT service organisation → classify as Enterprise, not Agency/Service Company

PE / VC Firms:
- Invests capital in businesses rather than selling products or services
- Private Equity (PE): invests in mature/established companies, often acquires controlling stakes, focuses on long-term value creation
- Venture Capital (VC): invests in early-stage or growth-stage startups, typically takes minority stakes, focuses on innovation and rapid growth

══ BUSINESS TYPE ══
B2B: Sells products/services to other businesses. Large deal sizes, longer sales cycles, relationship-driven.
B2C: Sells directly to individual consumers. Shorter purchase decisions, marketing-driven.
B2B and B2C: Serves both businesses and individual consumers.

══ ACCOUNT SIZE (by employee count) ══
StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)

══ INDUSTRIES & SUB-INDUSTRIES ══
Use exactly one industry and its matching sub-industry from this taxonomy:

Media & Entertainment → Broadcasters | Studios & Content Owners | OTT Platforms | Content Syndicators & Distributors | Publishing | General Entertainment Content | News | Gaming | Radio & Music | Cookery Media
Financial Services → Retail & Commercial Banking | Investment Management | Insurance | Wealth Management | Payments | NBFC / Lending | Accounting | Others (Fintech & Capital Markets)
Healthcare & Life Sciences → Pharmaceuticals | Healthcare Providers | Health Wellness & Fitness | Medical Devices
Travel & Hospitality → Air Travel | Aerospace | Hotels | OTA (Online Travel Agencies)
Business Software / Internet (SaaS) → AdTech & MarTech | ERP & Procurement Platforms | AI Platforms & Chatbots | HRMS & Workforce Management | Data Management & Analytics | Cybersecurity Platforms | Other B2B SaaS
Sports → Leagues | Clubs & Teams | Sports Federations
Wagering → Gambling Facilities & Casinos | Operators | iGaming | Lotteries | Platform Providers
Retail → E-Commerce
Agriculture Resources & Utilities → Oil & Energy | Mining | Power & Utilities | Agriculture & AgriTech
Business Services → IT Services & Consulting | BPM / BPO Companies | Marketing & Advertising | Tax Audit & Legal Services | Translation & Localization
Government & Public Sector → Government & Public Sector
Telecom → Telecom
Industrial & Manufacturing → Industrial & Manufacturing
Automobile → Automobile
Food & Beverage → Food & Beverage
FMCG & CPG → FMCG & CPG
Real Estate → Real Estate
PE / VC Firms → PE / VC Firms
Animation & Gaming → Animation & Gaming
Internet (Digital Platforms) → Internet (Digital Platforms)

══ REGIONS ══
North America | EMEA | APAC | LATAM | India

══ OUTPUT FORMAT ══
Return a JSON object with EXACTLY these keys (all required):
{
  "accountName": "Official company name",
  "website": "the website domain provided",
  "draInsights": "2-3 sentence summary: what the company does, their business model, key products/services, and market position",
  "engineeringIT": "Known tech stack, programming languages, frameworks, cloud infrastructure (e.g. Python, React, AWS, Kubernetes). Write Unknown if not determinable.",
  "devOps": "Known DevOps tools and practices (e.g. GitHub Actions, Jenkins, Docker, CI/CD). Write Unknown if not determinable.",
  "employeeCount": "Estimated employee count as a number or range (e.g. 5000, 1000-5000)",
  "accountTypeBySize": "Exactly one of: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "Exactly one of: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountLinkedIn": "Full LinkedIn company page URL (e.g. https://www.linkedin.com/company/stripe) or empty string if unknown",
  "businessType": "Exactly one of: B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from the taxonomy above",
  "subIndustry": "Exactly one sub-industry matching the chosen industry",
  "revenueUSD": "Estimated annual revenue in USD millions as a number or range (e.g. 500, 100-500). Write Unknown if not determinable.",
  "billingCity": "HQ city (e.g. San Francisco). Write Unknown if not determinable.",
  "billingState": "HQ state or province (e.g. California). Write Unknown if not determinable.",
  "billingCountry": "HQ country (e.g. United States). Write Unknown if not determinable.",
  "region": "Exactly one of: North America | EMEA | APAC | LATAM | India",
  "timeZone": "Primary HQ timezone (e.g. PST / UTC-8). Write Unknown if not determinable."
}`;

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify Supabase JWT ───────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized — please log in" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 2. Rate limiting ─────────────────────────────────────
    const { allowed, remaining } = checkRateLimit(user.id);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. You can enrich up to 100 accounts per hour." }), {
        status: 429,
        headers: {
          ...CORS,
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": "0",
        },
      });
    }

    // ── 3. Parse request body ────────────────────────────────
    const body = await req.json();
    const website: string = body?.website?.trim();

    if (!website) {
      return new Response(JSON.stringify({ error: "website field is required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 4. Call Anthropic API ────────────────────────────────
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) {
      return new Response(JSON.stringify({ error: "Anthropic API key not configured on server. Contact your admin." }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: AI_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Research this company thoroughly and return ALL fields in JSON.\nWebsite: ${website}\n\nReturn the complete JSON object with all 18 required fields as specified in the system prompt.`,
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic error:", errText);
      return new Response(JSON.stringify({ error: "AI service error. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const anthropicData = await anthropicRes.json();
    let rawText = anthropicData.content?.map((c: { text?: string }) => c.text || "").join("") || "";

    // ── 5. Parse JSON from response ──────────────────────────
    const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) rawText = jsonMatch[1];
    else {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      if (start !== -1 && end !== -1) rawText = rawText.slice(start, end + 1);
    }

    let enriched: Record<string, string>;
    try {
      enriched = JSON.parse(rawText.trim());
    } catch {
      return new Response(JSON.stringify({ error: "Failed to parse AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 6. Return enriched data ──────────────────────────────
    return new Response(JSON.stringify({ data: enriched, remaining }), {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": String(remaining),
      },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
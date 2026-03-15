// AccountIQ — Supabase Edge Function (Groq — FREE, worldwide)
// File: supabase/functions/enrich/index.ts
//
// Deploy:  supabase functions deploy enrich --no-verify-jwt
// Secret:  supabase secrets set GROQ_API_KEY=gsk_...
// Get key: https://console.groq.com  (free, no credit card)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RATE_LIMIT = 100;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 3600_000 });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (entry.count >= RATE_LIMIT) return { allowed: false, remaining: 0 };
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

const SYSTEM_PROMPT = `You are an expert account research AI for a B2B CRM platform. Analyse the given company website and return ONLY a valid JSON object — no markdown, no explanation, no preamble.

══ ACCOUNT TYPE DEFINITIONS ══
Enterprise: Large org (1000+ employees) OR smaller org (~45+ employees) with multiple business lines. ROI mainly from OFFLINE channels. Sells only own products via website = Enterprise not Consumer Portal. Examples: tejasnetworks.com, wforwoman.com, wildcraft.com
ISV: Owns its own software product/platform. Revenue via subscriptions/licensing. Must be INDEPENDENT (not acquired). Core business = software product NOT services.
Consumer Portal: ROI mainly from online platforms. Operates as MARKETPLACE connecting buyers and sellers. Revenue from transactions/commissions/ads. If org only sells own products → Enterprise NOT Consumer Portal.
Agency/Service Company: Provides IT SERVICES only (consulting, app dev, web dev). No proprietary software product. Non-IT service org → Enterprise.
PE/VC Firms: Invests capital only. Does not sell products or services. PE = mature companies, controlling stakes. VC = early-stage startups, minority stakes.

══ BUSINESS TYPE ══
B2B: sells to businesses | B2C: sells to consumers | B2B and B2C: serves both

══ CLOUD PLATFORM CLASSIFICATION ══
Identify the primary cloud/hosting infrastructure. Use these values:
- Hyperscalers: AWS | Azure (Microsoft Azure) | GCP (Google Cloud)
- Other Cloud: Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Linode | Vultr
- Edge/Hosting: Cloudflare | Vercel | Netlify | Heroku | Render
- On-premise: On-premise (if company runs own data centers)
- Multi-cloud: Multi-cloud (if uses 2+ major cloud providers)
- Unknown: if cannot be determined

══ ACCOUNT SIZE ══
StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)

══ INDUSTRIES & SUB-INDUSTRIES ══
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

══ REQUIRED JSON OUTPUT ══
Return ONLY a JSON object with exactly these 19 keys:
{
  "accountName": "Official company name",
  "website": "domain provided",
  "draInsights": "2-3 sentence summary of what company does, business model, key products, market position",
  "engineeringIT": "Known tech stack, programming languages, frameworks (e.g. Python, React, Node.js, Java). Write Unknown if not determinable.",
  "cloudPlatform": "Primary cloud/hosting platform used by the company. Examples: AWS, Azure, GCP, Oracle Cloud, IBM Cloud, Alibaba Cloud, DigitalOcean, Heroku, Vercel, Netlify, Cloudflare, On-premise, Multi-cloud. Write Unknown if not determinable.",
  "devOps": "Known DevOps tools and CI/CD practices (e.g. GitHub Actions, Jenkins, Docker, Kubernetes, Terraform). Write Unknown if not determinable.",
  "employeeCount": "Estimated count or range e.g. 5000 or 1000-5000",
  "accountTypeBySize": "Exactly one of: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "Exactly one of: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountLinkedIn": "Full LinkedIn company URL e.g. https://www.linkedin.com/company/stripe or empty string",
  "businessType": "Exactly one of: B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from taxonomy above",
  "subIndustry": "Exactly one matching sub-industry",
  "revenueUSD": "Estimated annual revenue in USD millions e.g. 500 or 100-500. Write Unknown if not determinable.",
  "billingCity": "HQ city. Write Unknown if not determinable.",
  "billingState": "HQ state/province. Write Unknown if not determinable.",
  "billingCountry": "HQ country. Write Unknown if not determinable.",
  "region": "Exactly one of: North America | EMEA | APAC | LATAM | India",
  "timeZone": "Primary HQ timezone e.g. PST / UTC-8. Write Unknown if not determinable."
}`;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify Supabase JWT ──────────────────────────────
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

    // ── 2. Rate limiting ────────────────────────────────────
    const { allowed, remaining } = checkRateLimit(user.id);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Max 100 enrichments per hour." }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Parse request ────────────────────────────────────
    const body = await req.json();
    const website: string = body?.website?.trim();
    if (!website) {
      return new Response(JSON.stringify({ error: "website field is required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 4. Call Groq API (FREE) ─────────────────────────────
    const groqKey = Deno.env.get("GROQ_API_KEY");
    if (!groqKey) {
      return new Response(JSON.stringify({ error: "Groq API key not configured. Contact your admin." }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Research this company and return all 18 fields as JSON.\nWebsite: ${website}` }
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error("Groq error:", errText);
      return new Response(JSON.stringify({ error: "AI service error. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqData = await groqRes.json();
    let rawText = groqData?.choices?.[0]?.message?.content || "";

    if (!rawText) {
      console.error("Empty Groq response:", JSON.stringify(groqData));
      return new Response(JSON.stringify({ error: "Empty AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 5. Parse JSON ───────────────────────────────────────
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
      console.error("JSON parse error. Raw:", rawText);
      return new Response(JSON.stringify({ error: "Failed to parse AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 6. Return result ────────────────────────────────────
    return new Response(JSON.stringify({ data: enriched, remaining }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json", "X-RateLimit-Remaining": String(remaining) },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
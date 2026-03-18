// AccountIQ v6 — Supabase Edge Function (Groq + Serper + LinkedIn)
// File: supabase/functions/enrich/index.ts
// Deploy:  supabase functions deploy enrich --no-verify-jwt
// Secrets: supabase secrets set GROQ_API_KEY=gsk_...
//          supabase secrets set SERPER_API_KEY=...

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

// ── LinkedIn URL Search — v6 improved: domain-based search ──
// Strategy: try multiple search queries in priority order and return first valid match
async function findLinkedInUrl(companyName: string, domain: string, serperKey: string): Promise<string> {
  // Build a clean domain without protocol/www
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  // Try 3 query strategies in order of reliability
  const queries = [
    `${cleanDomain} site:linkedin.com/company`,           // most precise — domain-based
    `"${companyName}" site:linkedin.com/company`,         // company name quoted
    `${companyName} company linkedin.com/company`,        // broader fallback
  ];

  for (const q of queries) {
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
        body: JSON.stringify({ q, num: 5 }),
      });
      if (!res.ok) {
        console.log(`Serper LinkedIn query failed (${res.status}) for: ${q}`);
        continue;
      }
      const data = await res.json();

      // Check organic results
      for (const item of (data?.organic || [])) {
        const link: string = item.link || "";
        if (link.includes("linkedin.com/company/")) {
          const match = link.match(/(https:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9_%-]+)/);
          if (match) {
            console.log(`LinkedIn found via query "${q}": ${match[1]}`);
            return match[1].replace("http://", "https://");
          }
        }
      }
      // Also check knowledge graph
      const kgWebsite = data?.knowledgeGraph?.website || "";
      if (kgWebsite.includes("linkedin.com/company/")) {
        return kgWebsite;
      }
    } catch (e) {
      console.error(`LinkedIn search error for query "${q}":`, e);
    }
  }
  console.log("No LinkedIn URL found via Serper — Groq will construct one");
  return "";
}

// ── Scrape LinkedIn public page ──────────────────────────────
interface LinkedInData {
  employeeCount: string;
  employeeRange: string;
  hqLocation: string;
  founded: string;
  industry: string;
  companyType: string;
  about: string;
  engineeringTeamSize: string;
  devOpsTeamSize: string;
}

async function scrapeLinkedIn(linkedinUrl: string): Promise<LinkedInData> {
  const empty: LinkedInData = {
    employeeCount: "", employeeRange: "", hqLocation: "", founded: "",
    industry: "", companyType: "", about: "", engineeringTeamSize: "", devOpsTeamSize: "",
  };
  try {
    const res = await fetch(linkedinUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
      },
    });
    if (!res.ok) { console.log("LinkedIn scrape HTTP status:", res.status); return empty; }

    const html = await res.text();

    // Employee range e.g. "1,001-5,000 employees"
    const empRangeMatch =
      html.match(/(\d[\d,]*[-–]\d[\d,]*)\s*employees/i) ||
      html.match(/"staffCount"\s*:\s*(\d+)/i) ||
      html.match(/(\d[\d,]+)\s*employees/i);
    const employeeRange = empRangeMatch ? empRangeMatch[1].replace(/,/g, "") : "";

    // Exact staff count from structured data
    const staffMatch =
      html.match(/"numberOfEmployees"[^}]*"value"\s*:\s*(\d+)/) ||
      html.match(/"staffCount"\s*:\s*(\d+)/);
    const employeeCount = staffMatch ? staffMatch[1] : "";

    // HQ location
    const hqMatch =
      html.match(/"addressLocality"\s*:\s*"([^"]+)"/) ||
      html.match(/"addressCountry"\s*:\s*"([^"]+)"/);
    const hqLocation = hqMatch ? hqMatch[1].trim() : "";

    // Founded year
    const foundedMatch =
      html.match(/[Ff]ounded\s*[:\s]*(\d{4})/) ||
      html.match(/"foundingDate"\s*:\s*"(\d{4})"/);
    const founded = foundedMatch ? foundedMatch[1] : "";

    // About from meta description
    const aboutMatch = html.match(/<meta\s+name="description"\s+content="([^"]{50,500})"/i);
    const about = aboutMatch ? aboutMatch[1].trim() : "";

    // Company type
    const typeMatch = html.match(/[Cc]ompany [Tt]ype[^:]{0,20}:\s*([^<]{1,50})/);
    const companyType = typeMatch ? typeMatch[1].trim() : "";

    // Engineering team size
    const engMatch =
      html.match(/Engineering[^<]{0,80}(\d[\d,]+)\s*(?:employees?|members?)/i) ||
      html.match(/(\d[\d,]+)\s*(?:employees?|members?)[^<]{0,50}Engineering/i) ||
      html.match(/"Engineering"\s*[^}]{0,200}"memberCount"\s*:\s*(\d+)/i);
    const engineeringTeamSize = engMatch ? engMatch[1].replace(/,/g, "") : "";

    // DevOps / Infrastructure team size
    const devopsMatch =
      html.match(/(?:DevOps|Infrastructure|Platform Engineering)[^<]{0,80}(\d[\d,]+)\s*(?:employees?|members?)/i) ||
      html.match(/"(?:DevOps|Infrastructure)"\s*[^}]{0,200}"memberCount"\s*:\s*(\d+)/i);
    const devOpsTeamSize = devopsMatch ? devopsMatch[1].replace(/,/g, "") : "";

    console.log(`LinkedIn scraped: employees=${employeeCount||employeeRange}, hq=${hqLocation}, eng=${engineeringTeamSize}`);
    return { employeeCount, employeeRange, hqLocation, founded, industry: "", companyType, about, engineeringTeamSize, devOpsTeamSize };
  } catch (e) {
    console.error("LinkedIn scrape error:", e);
    return empty;
  }
}

// ── Serper company web search ────────────────────────────────
async function searchCompanyInfo(companyName: string, domain: string, serperKey: string): Promise<string> {
  try {
    const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const query = `${companyName} ${cleanDomain} company employees headquarters revenue overview`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    if (!res.ok) {
      console.log("Serper company search failed:", res.status);
      return "";
    }
    const data = await res.json();
    const snippets: string[] = [];

    // Knowledge graph (highest priority)
    const kg = data?.knowledgeGraph;
    if (kg?.description) snippets.push("About: " + kg.description);
    if (kg?.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        snippets.push(`${k}: ${v}`);
      }
    }
    // Answer box
    if (data?.answerBox?.answer) snippets.push(data.answerBox.answer);
    if (data?.answerBox?.snippet) snippets.push(data.answerBox.snippet);
    // Organic snippets
    for (const item of (data?.organic || []).slice(0, 5)) {
      if (item.snippet) snippets.push(item.snippet);
      // Also grab title — often contains company description
      if (item.title && item.title.length > 20) snippets.push("Title: " + item.title);
    }

    const result = snippets.join("\n").slice(0, 2500);
    console.log("Web context length:", result.length);
    return result;
  } catch (e) {
    console.error("Company search error:", e);
    return "";
  }
}

// ══════════════════════════════════════════════════════════════
// SYSTEM PROMPT — v6 (improved accuracy + stricter rules)
// ══════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `You are an expert B2B account research analyst. Given a company website and research data, return a complete 20-field JSON profile. Use the provided real data (LinkedIn, web search) first — only infer when data is missing.

CRITICAL: Think step-by-step for accountType — follow the decision tree below exactly.

════════════════════════════════════════════
STEP 1 — DECIDE ACCOUNT TYPE (use this decision tree)
════════════════════════════════════════════

Question 1: Does the company invest capital in other companies (no products/services)?
→ YES → PE/VC Firms

Question 2: Does the company ONLY provide IT services? (consulting, app dev, web dev, QA, staffing)
→ YES → Agency/Service Company
→ IMPORTANT: If a company also makes its own software product, it is ISV, not Agency.

Question 3: Does the company own a software product/platform with subscription/license revenue?
→ YES → Check: Is it INDEPENDENT (not fully acquired subsidiary)?
  → INDEPENDENT → ISV
  → Acquired subsidiary with no independent identity → classify by parent
→ NO → continue

Question 4: Is the company a marketplace/platform that CONNECTS buyers and sellers?
→ YES (revenue from commissions, transactions, ads on others' goods) → Consumer Portal
→ NO but sells ONLY its own products → Enterprise (not Consumer Portal)

Question 5: Does the company sell physical products or provide non-IT services?
→ YES → Enterprise

Question 6: Is it a larger org (45+ employees) with multiple business lines and offline distribution?
→ YES → Enterprise

Default for anything else → Enterprise

ACCOUNT TYPE EXAMPLES:
- tejasnetworks.com → Enterprise (sells own telecom hardware, offline B2B sales)
- wforwoman.com → Enterprise (own fashion brand, retail stores)
- wildcraft.com → Enterprise (own outdoor gear brand, retail + online)
- tripjack.com → Consumer Portal (OTA marketplace connecting travellers + airlines)
- makemytrip.com → Consumer Portal (marketplace, not own airline/hotel)
- freshworks.com → ISV (owns SaaS CRM/ITSM products, subscription revenue)
- zoho.com → ISV (owns software suite, subscription)
- infosys.com → Agency/Service Company (IT services, consulting)
- sequoiacap.com → PE/VC Firms

════════════════════════════════════════════
STEP 2 — BUSINESS TYPE
════════════════════════════════════════════
Use EXACTLY one of: B2B | B2C | B2B and B2C

Rules:
- ISV selling to businesses → B2B
- ISV with consumer app (Canva, Notion free plan) → B2B and B2C
- E-commerce selling to consumers → B2C
- Enterprise selling own products to other businesses → B2B
- Marketplace (Consumer Portal) serving both → B2B and B2C
- IT services → B2B

════════════════════════════════════════════
STEP 3 — ACCOUNT SIZE
════════════════════════════════════════════
Use LinkedIn employee count if provided. Otherwise estimate from industry signals.

EXACT SIZE LABELS (copy exactly):
StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)

════════════════════════════════════════════
STEP 4 — INDUSTRY & SUB-INDUSTRY TAXONOMY
════════════════════════════════════════════
Pick EXACTLY ONE industry and ONE matching sub-industry from this list:

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

Sub-industry rules:
- OTA marketplaces (TripJack, MakeMyTrip) → Travel & Hospitality → OTA (Online Travel Agencies)
- B2B SaaS products → Business Software / Internet (SaaS) → [most specific sub]
- IT services companies → Business Services → IT Services & Consulting
- Telecom hardware makers (Tejas Networks) → Telecom → Telecom

════════════════════════════════════════════
STEP 5 — REGIONS
════════════════════════════════════════════
EXACTLY one of: North America | EMEA | APAC | LATAM | India

India is its own region (not APAC). All Indian companies → India.
Singapore, Japan, Australia, SE Asia → APAC
UK, Europe, Middle East, Africa → EMEA
USA, Canada, Mexico → North America

════════════════════════════════════════════
STEP 6 — CLOUD & ENGINEERING
════════════════════════════════════════════
Cloud Platform:
- Single platform: AWS | Azure | GCP | Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Cloudflare | On-premise
- Multi-cloud: "Multi-cloud (AWS, GCP)" — list specific platforms
- Signals: Indian startups/SaaS → AWS or GCP | Microsoft stack → Azure | Large enterprise → Multi-cloud

Engineering & DevOps MUST include team size. Format:
  engineeringIT: "[Tech Stack] | Team Size: [number or range]"
  devOps:        "[Tools & Practices] | Team Size: [number or range]"

Team size estimation from total employees:
- Pure tech/SaaS: 50-70% are engineers | Travel/e-commerce: 20-40% | IT services: 60-80% | Retail/FMCG: 5-15%
- DevOps = 10-20% of engineering for modern SaaS | 5-10% for enterprise/traditional

Examples:
  engineeringIT: "React, Node.js, Python, Java microservices, PostgreSQL, Redis | Team Size: 150-200"
  devOps: "GitHub Actions, Docker, Kubernetes, Terraform, AWS ECS | Team Size: 20-30"

════════════════════════════════════════════
STEP 7 — LOCATION & TIMEZONE INFERENCE
════════════════════════════════════════════
Use LinkedIn HQ location if provided. Otherwise:
- .in domain → India
- City inference: travel/fintech → Gurugram or Bengaluru | e-commerce → Mumbai or Bengaluru | enterprise telecom → Bengaluru
- State from city: Bengaluru=Karnataka, Mumbai=Maharashtra, Gurugram=Haryana, Hyderabad=Telangana, Pune=Maharashtra, Chennai=Tamil Nadu, Delhi=Delhi
- Timezone: India=IST/UTC+5:30 | UK=GMT/UTC+0 | UAE=GST/UTC+4 | Singapore=SGT/UTC+8 | US West=PST/UTC-8 | US East=EST/UTC-5

════════════════════════════════════════════
OUTPUT — return ONLY valid JSON, all 20 keys
════════════════════════════════════════════
{
  "accountName": "Official company name (not website URL)",
  "website": "Exact domain as provided by user — do NOT alter",
  "draInsights": "2-3 sentences: what company does, business model, key products/services, market position",
  "engineeringIT": "[Tech Stack] | Team Size: [number or range]",
  "cloudPlatform": "e.g. AWS or Multi-cloud (AWS, GCP)",
  "devOps": "[Tools & Practices] | Team Size: [number or range]",
  "employeeCount": "Number or range from LinkedIn if available, else estimate",
  "accountTypeBySize": "Exact label: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "Exact label: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1-2 sentences: specific evidence for accountType — mention business model, revenue type, and/or product ownership",
  "accountLinkedIn": "Real LinkedIn URL from research if found, else construct: https://www.linkedin.com/company/[slug]",
  "businessType": "B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from taxonomy",
  "subIndustry": "Exactly one sub-industry from taxonomy",
  "revenueUSD": "From web search if available (e.g. $50M), else estimate with basis",
  "billingCity": "From LinkedIn/search if available, else infer from domain/industry",
  "billingState": "Derived from city",
  "billingCountry": "From research or infer from domain TLD",
  "region": "North America | EMEA | APAC | LATAM | India",
  "timeZone": "e.g. IST / UTC+5:30"
}`;

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    // ── 1. Verify JWT ───────────────────────────────────────
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

    // ── 2. Rate limit ───────────────────────────────────────
    const { allowed, remaining } = checkRateLimit(user.id);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Max 100 enrichments per hour." }), {
        status: 429, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 3. Parse request ────────────────────────────────────
    const body = await req.json();
    const website: string = (body?.website || "").trim();
    if (!website) {
      return new Response(JSON.stringify({ error: "website field is required" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const groqKey = Deno.env.get("GROQ_API_KEY");
    const serperKey = Deno.env.get("SERPER_API_KEY");

    if (!groqKey) {
      return new Response(JSON.stringify({ error: "API key not configured. Contact your admin." }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 4. Extract company name from domain ─────────────────
    const cleanDomain = website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    const companyName = cleanDomain
      .split(".")[0]
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

    console.log(`v6 enriching: ${website} | company: ${companyName}`);

    // ── 5. Parallel web research ─────────────────────────────
    let linkedInUrl = "";
    let linkedInData: LinkedInData = {
      employeeCount: "", employeeRange: "", hqLocation: "", founded: "",
      industry: "", companyType: "", about: "", engineeringTeamSize: "", devOpsTeamSize: "",
    };
    let webSearchContext = "";

    if (serperKey) {
      try {
        console.log("Running parallel Serper searches...");
        const t0 = Date.now();

        // Run LinkedIn search and company info search in parallel
        const [liUrl, webCtx] = await Promise.all([
          findLinkedInUrl(companyName, website, serperKey),
          searchCompanyInfo(companyName, website, serperKey),
        ]);

        linkedInUrl = liUrl;
        webSearchContext = webCtx;
        console.log(`Serper done in ${Date.now() - t0}ms. LinkedIn: ${linkedInUrl || "none"}`);

        // Scrape LinkedIn page if URL found
        if (linkedInUrl) {
          linkedInData = await scrapeLinkedIn(linkedInUrl);
        }
      } catch (searchErr) {
        console.log("Web search error (quota or network) — falling back to Groq-only:", searchErr);
      }
    } else {
      console.log("No Serper key — Groq-only mode");
    }

    // ── 6. Build research context ───────────────────────────
    const researchLines = [
      linkedInUrl   ? `LinkedIn URL (VERIFIED — use exactly): ${linkedInUrl}` : "",
      linkedInData.employeeRange  ? `LinkedIn Employees (range): ${linkedInData.employeeRange}` : "",
      linkedInData.employeeCount  ? `LinkedIn Staff Count (exact): ${linkedInData.employeeCount}` : "",
      linkedInData.engineeringTeamSize ? `LinkedIn Engineering Team: ${linkedInData.engineeringTeamSize} people` : "",
      linkedInData.devOpsTeamSize ? `LinkedIn DevOps/Infra Team: ${linkedInData.devOpsTeamSize} people` : "",
      linkedInData.hqLocation     ? `LinkedIn HQ: ${linkedInData.hqLocation}` : "",
      linkedInData.founded        ? `Founded: ${linkedInData.founded}` : "",
      linkedInData.about          ? `LinkedIn About: ${linkedInData.about}` : "",
      webSearchContext            ? `\nWEB SEARCH RESULTS:\n${webSearchContext}` : "",
    ].filter(Boolean).join("\n");

    const hasRealData = !!(linkedInUrl || webSearchContext);

    // ── 7. Build user message ───────────────────────────────
    const looksLikeDomain = website.includes(".");
    const userMessage = `Analyze this company and return the complete 20-field JSON profile.

${looksLikeDomain ? `Website/Domain: ${website}` : `Company Name: ${website}\nNote: No domain provided. Find the correct website domain.`}
Company Name (extracted): ${companyName}

${hasRealData
  ? `=== VERIFIED RESEARCH DATA ===\n${researchLines}\n\nIMPORTANT: Use the above real data. LinkedIn employee count is the most accurate size signal. LinkedIn URL is verified — use it exactly in accountLinkedIn field.`
  : `No live web data available. Use your full training knowledge. Make confident inferences — do NOT return "Unknown" when inference is possible.`}

MANDATORY RULES:
1. "website" field MUST be exactly: ${website} — do not modify it
2. If LinkedIn URL was found above, copy it EXACTLY into accountLinkedIn — do not construct a different URL
3. Follow the decision tree in the system prompt to determine accountType
4. accountTypeReason must cite specific evidence (business model, product ownership, revenue type)
5. For Indian companies: region=India, timeZone=IST / UTC+5:30
6. Both engineeringIT and devOps MUST include "| Team Size: [estimate]"`;

    // ── 8. Call Groq ────────────────────────────────────────
    console.log("Calling Groq llama-3.3-70b...");
    const t1 = Date.now();

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.05,        // v6: lower temp for more deterministic output
        max_tokens: 1800,         // v6: slightly more room for accountTypeReason
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
      }),
    });

    console.log(`Groq responded in ${Date.now() - t1}ms`);

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
      return new Response(JSON.stringify({ error: "Empty AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 9. Parse JSON ───────────────────────────────────────
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
      console.error("JSON parse error. Raw:", rawText.slice(0, 500));
      return new Response(JSON.stringify({ error: "Failed to parse AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 10. Post-processing overrides ───────────────────────

    // Always force website to exactly what user provided
    enriched.website = website;

    // Always use the verified LinkedIn URL if Serper found one
    if (linkedInUrl && linkedInUrl.includes("linkedin.com/company/")) {
      enriched.accountLinkedIn = linkedInUrl;
      console.log("LinkedIn URL overridden with verified Serper result:", linkedInUrl);
    }

    // Normalize accountLinkedIn — ensure it starts with https://
    if (enriched.accountLinkedIn && !enriched.accountLinkedIn.startsWith("http")) {
      enriched.accountLinkedIn = "https://" + enriched.accountLinkedIn;
    }

    // ── 11. Return ──────────────────────────────────────────
    console.log(`v6 enrichment complete: ${enriched.accountName} | ${enriched.accountType} | ${enriched.industry}`);
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
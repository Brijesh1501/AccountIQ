// AccountIQ — Supabase Edge Function (Groq + Web Search + LinkedIn scrape)
// File: supabase/functions/enrich/index.ts
// Deploy:  supabase functions deploy enrich --no-verify-jwt
// Secrets: supabase secrets set GROQ_API_KEY=gsk_...
//          supabase secrets set SERPER_API_KEY=...  (free at serper.dev - 2500/month free)

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

// ── Step 1: Search for LinkedIn URL via Serper ──────────────
async function findLinkedInUrl(companyName: string, website: string, serperKey: string): Promise<string> {
  try {
    const query = `${companyName} site:linkedin.com/company`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) {
      console.log("Serper LinkedIn search failed:", res.status, "— falling back to Groq");
      return "";
    }
    const data = await res.json();
    // Find first linkedin.com/company result
    for (const item of data?.organic || []) {
      const link: string = item.link || "";
      if (link.includes("linkedin.com/company/")) {
        // Clean URL — remove trailing slashes and query params
        const match = link.match(/(https:\/\/[a-z]+\.linkedin\.com\/company\/[a-zA-Z0-9_-]+)/);
        if (match) return match[1];
      }
    }
    // Also check knowledge graph
    const kg = data?.knowledgeGraph;
    if (kg?.website) {
      const kgLink = kg.website;
      if (kgLink.includes("linkedin.com/company/")) return kgLink;
    }
    return "";
  } catch (e) {
    console.error("Serper search error:", e);
    return "";
  }
}

// ── Step 2: Scrape LinkedIn public page ─────────────────────
interface LinkedInData {
  employeeCount: string;
  employeeRange: string;
  hqLocation: string;
  founded: string;
  industry: string;
  companyType: string;
  website: string;
  about: string;
}

async function scrapeLinkedIn(linkedinUrl: string): Promise<LinkedInData> {
  const empty: LinkedInData = { employeeCount: "", employeeRange: "", hqLocation: "", founded: "", industry: "", companyType: "", website: "", about: "" };
  try {
    // LinkedIn blocks most scrapers — use a User-Agent that mimics a real browser
    const res = await fetch(linkedinUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    if (!res.ok) {
      console.log("LinkedIn fetch status:", res.status);
      return empty;
    }

    const html = await res.text();

    // Extract employee count — LinkedIn shows "1,001-5,000 employees" or "501-1,000 employees"
    const empRangeMatch = html.match(/(\d[\d,]*[-–]\d[\d,]*)\s*employees/i) ||
                          html.match(/"staffCount"\s*:\s*(\d+)/i) ||
                          html.match(/(\d[\d,]+)\s*employees/i);
    const employeeRange = empRangeMatch ? empRangeMatch[1].replace(/,/g, "") : "";

    // Extract staff count from JSON-LD or meta
    const staffMatch = html.match(/"numberOfEmployees"[^}]*"value"\s*:\s*(\d+)/) ||
                       html.match(/"staffCount"\s*:\s*(\d+)/);
    const employeeCount = staffMatch ? staffMatch[1] : "";

    // Extract HQ location
    const hqMatch = html.match(/"addressLocality"\s*:\s*"([^"]+)"/) ||
                    html.match(/headquartered in ([^<\n,]+)/i) ||
                    html.match(/"addressCountry"\s*:\s*"([^"]+)"/);
    const hqLocation = hqMatch ? hqMatch[1].trim() : "";

    // Extract founded year
    const foundedMatch = html.match(/[Ff]ounded\s*[:\s]*(\d{4})/) ||
                         html.match(/"foundingDate"\s*:\s*"(\d{4})"/);
    const founded = foundedMatch ? foundedMatch[1] : "";

    // Extract about/description
    const aboutMatch = html.match(/<meta\s+name="description"\s+content="([^"]{50,500})"/i) ||
                       html.match(/class="[^"]*description[^"]*"[^>]*>([^<]{50,400})</i);
    const about = aboutMatch ? aboutMatch[1].trim() : "";

    // Extract company type
    const typeMatch = html.match(/[Cc]ompany [Tt]ype[^:]*:\s*([^\n<]+)/);
    const companyType = typeMatch ? typeMatch[1].trim() : "";

    return { employeeCount, employeeRange, hqLocation, founded, industry: "", companyType, website: "", about };
  } catch (e) {
    console.error("LinkedIn scrape error:", e);
    return empty;
  }
}

// ── Step 3: Search for extra company info ───────────────────
async function searchCompanyInfo(companyName: string, website: string, serperKey: string): Promise<string> {
  try {
    const query = `${companyName} ${website} company headquarters employees revenue`;
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": serperKey },
      body: JSON.stringify({ q: query, num: 5 }),
    });
    if (!res.ok) {
      console.log("Serper company search failed:", res.status, "— falling back to Groq");
      return "";
    }
    const data = await res.json();
    const snippets: string[] = [];
    // Knowledge graph
    const kg = data?.knowledgeGraph;
    if (kg?.description) snippets.push("About: " + kg.description);
    if (kg?.attributes) {
      for (const [k, v] of Object.entries(kg.attributes)) {
        snippets.push(`${k}: ${v}`);
      }
    }
    // Organic snippets
    for (const item of (data?.organic || []).slice(0, 4)) {
      if (item.snippet) snippets.push(item.snippet);
    }
    // Answer box
    if (data?.answerBox?.answer) snippets.push(data.answerBox.answer);
    if (data?.answerBox?.snippet) snippets.push(data.answerBox.snippet);
    return snippets.join("\n").slice(0, 2000);
  } catch (e) {
    console.error("Company search error:", e);
    return "";
  }
}

const SYSTEM_PROMPT = `You are an expert B2B account research analyst. Given a company website and research data, return a comprehensive JSON profile. Use the provided real data (LinkedIn, web search) — only fall back to inference when data is missing.

════════════════════════════════════════════
ACCOUNT TYPE — Use exactly ONE
════════════════════════════════════════════
ENTERPRISE: 1000+ employees OR smaller org (~45+) with multiple business lines. ROI mainly from OFFLINE channels (stores, distributors, direct sales). Sells own products via website = Enterprise (not Consumer Portal). Examples: tejasnetworks.com, wforwoman.com, wildcraft.com
ISV: Owns its own software product/platform. Revenue via subscriptions/licensing. INDEPENDENT (not acquired). Core = software product NOT services. Examples: Freshworks, Zoho, Postman
CONSUMER PORTAL: Marketplace connecting buyers and sellers. Revenue from transactions/commissions/ads. If only sells own products → Enterprise. Examples: Amazon, MakeMyTrip, TripJack (OTA marketplace)
AGENCY/SERVICE COMPANY: Provides IT SERVICES only (consulting, app dev, web dev). No proprietary software. Non-IT service → Enterprise.
PE/VC FIRMS: Invests capital only. No products/services.

════════════════════════════════════════════
BUSINESS TYPE
════════════════════════════════════════════
B2B | B2C | B2B and B2C

════════════════════════════════════════════
ACCOUNT SIZE
════════════════════════════════════════════
StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)
Use LinkedIn employee count if provided — it is the most accurate signal.

════════════════════════════════════════════
INDUSTRIES & SUB-INDUSTRIES
════════════════════════════════════════════
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
Government & Public Sector → Government & Public Sector | Telecom → Telecom | Industrial & Manufacturing → Industrial & Manufacturing
Automobile → Automobile | Food & Beverage → Food & Beverage | FMCG & CPG → FMCG & CPG | Real Estate → Real Estate
PE / VC Firms → PE / VC Firms | Animation & Gaming → Animation & Gaming | Internet (Digital Platforms) → Internet (Digital Platforms)

════════════════════════════════════════════
REGIONS
════════════════════════════════════════════
North America | EMEA | APAC | LATAM | India

════════════════════════════════════════════
CLOUD PLATFORM
════════════════════════════════════════════
Single: AWS | Azure | GCP | Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Cloudflare | Vercel | Netlify | Heroku | On-premise
Multi-cloud: Multi-cloud (AWS, GCP) pattern — list specific platforms
Infer: Indian startups → AWS/GCP | Travel portals → AWS | Microsoft-stack → Azure

════════════════════════════════════════════
INFERENCE RULES (when real data is missing)
════════════════════════════════════════════
- Location: .in domain = India. Infer city from company type (travel/fintech → Gurugram or Bangalore)
- State from city: Bangalore=Karnataka, Mumbai=Maharashtra, Gurugram=Haryana, Hyderabad=Telangana
- Timezone: India=IST/UTC+5:30, UK=GMT/UTC+0, UAE=GST/UTC+4, Singapore=SGT/UTC+8, US West=PST/UTC-8, US East=EST/UTC-5
- LinkedIn URL: construct as https://www.linkedin.com/company/[company-name-slug] if not provided
- Engineering: travel portals=React/Node.js/Python/Java | fintech=Java/Python/Go | SaaS=React/Node.js
- DevOps: modern startup=GitHub Actions+Docker+Kubernetes | enterprise=Jenkins+Terraform+Kubernetes
- Revenue: use web search data if available, else estimate from company stage

════════════════════════════════════════════
OUTPUT — all 20 keys required
════════════════════════════════════════════
Return ONLY valid JSON:
{
  "accountName": "Official company name",
  "website": "domain as provided",
  "draInsights": "2-3 sentences: what company does, business model, key products/services, market position",
  "engineeringIT": "Tech stack from research or inference",
  "cloudPlatform": "Cloud platform — single name or Multi-cloud (X, Y) pattern",
  "devOps": "DevOps tools and CI/CD practices",
  "employeeCount": "Use LinkedIn employee count/range if available, else estimate",
  "accountTypeBySize": "One of: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "One of: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1-2 sentences explaining WHY with specific evidence",
  "accountLinkedIn": "Real LinkedIn URL from search if found, else constructed URL",
  "businessType": "One of: B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from taxonomy",
  "subIndustry": "Exactly one matching sub-industry",
  "revenueUSD": "From web search if available, else estimate in USD millions",
  "billingCity": "From LinkedIn/search if found, else infer",
  "billingState": "Derived from city",
  "billingCountry": "From LinkedIn/search or infer from domain TLD",
  "region": "One of: North America | EMEA | APAC | LATAM | India",
  "timeZone": "Derived from country/city e.g. IST / UTC+5:30"
}`;

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
    const website: string = body?.website?.trim();
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

    // ── 4. Extract company name from website ────────────────
    const companyName = website
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/-/g, " ")
      .trim();

    // ── 5. Parallel: Search LinkedIn URL + Company Info ─────
    let linkedInUrl = "";
    let linkedInData: LinkedInData = { employeeCount: "", employeeRange: "", hqLocation: "", founded: "", industry: "", companyType: "", website: "", about: "" };
    let webSearchContext = "";

    if (serperKey) {
      console.log("Running web search for:", website);
      try {
        const [liUrl, webCtx] = await Promise.all([
          findLinkedInUrl(companyName, website, serperKey),
          searchCompanyInfo(companyName, website, serperKey),
        ]);
        linkedInUrl = liUrl;
        webSearchContext = webCtx;
        console.log("LinkedIn URL found:", linkedInUrl || "none");
        console.log("Web context length:", webSearchContext.length);

        // Scrape LinkedIn if URL found
        if (linkedInUrl) {
          linkedInData = await scrapeLinkedIn(linkedInUrl);
          console.log("LinkedIn data:", JSON.stringify(linkedInData));
        }
      } catch (searchErr) {
        // Serper quota exhausted or any other error — silently fall back to Groq-only
        console.log("Web search failed (possibly quota exhausted) — using Groq knowledge only:", searchErr);
        linkedInUrl = "";
        webSearchContext = "";
      }
    } else {
      console.log("No Serper key configured — using Groq knowledge only");
    }

    // ── 7. Build research context for AI ───────────────────
    const researchContext = [
      linkedInUrl ? `LinkedIn URL: ${linkedInUrl}` : "",
      linkedInData.employeeRange ? `LinkedIn Employee Range: ${linkedInData.employeeRange} employees` : "",
      linkedInData.employeeCount ? `LinkedIn Staff Count: ${linkedInData.employeeCount}` : "",
      linkedInData.hqLocation ? `LinkedIn HQ Location: ${linkedInData.hqLocation}` : "",
      linkedInData.founded ? `Founded: ${linkedInData.founded}` : "",
      linkedInData.about ? `LinkedIn About: ${linkedInData.about}` : "",
      webSearchContext ? `\nWeb Search Results:\n${webSearchContext}` : "",
    ].filter(Boolean).join("\n");

    // ── 8. Call Groq ────────────────────────────────────────
    const searchWasUsed = !!(linkedInUrl || webSearchContext);
    const userMessage = `Research this company and return the complete 20-field JSON profile.

Website: ${website}
Company Name (extracted): ${companyName}

${researchContext ? `=== REAL DATA FROM WEB RESEARCH ===\n${researchContext}\n\nUse the above real data to fill fields accurately. LinkedIn employee count is the most reliable source for company size.` : "No web search data available — use your full training knowledge to fill all fields. Make confident inferences based on company type, domain TLD, and industry context. Do not return Unknown when inference is possible."}

Important:
- If LinkedIn URL was found above, use it exactly as provided
- If LinkedIn employee range is provided, use it for employeeCount and accountTypeBySize
- If HQ location is provided, use it for billingCity/State/Country
- For any fields not covered by research data, use confident inference based on company type and region
- For Indian companies: region=India, timezone=IST/UTC+5:30`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
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
      console.error("JSON parse error. Raw:", rawText);
      return new Response(JSON.stringify({ error: "Failed to parse AI response. Please try again." }), {
        status: 502, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── 10. Override with real LinkedIn URL if found ────────
    if (linkedInUrl && linkedInUrl.includes("linkedin.com/company/")) {
      enriched.accountLinkedIn = linkedInUrl;
    }

    // ── 11. Return ──────────────────────────────────────────
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
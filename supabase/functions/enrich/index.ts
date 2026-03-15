// AccountIQ — Supabase Edge Function (Groq — FREE, worldwide)
// File: supabase/functions/enrich/index.ts
// Deploy:  supabase functions deploy enrich --no-verify-jwt
// Secret:  supabase secrets set GROQ_API_KEY=gsk_...

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

const SYSTEM_PROMPT = `You are an expert B2B account research analyst for a CRM platform. Given a company website, return a comprehensive JSON profile using your full training knowledge. Be confident — make reasonable inferences rather than saying Unknown.

════════════════════════════════════════════
ACCOUNT TYPE — Use exactly ONE of these five
════════════════════════════════════════════

ENTERPRISE:
- Organisation with 1000+ employees, OR smaller org (~45+ employees) with multiple business lines/sub-businesses
- Can be tech or non-tech depending on scale of technology usage
- Operates across multiple domains, sub-businesses, or business lines
- ROI/profitability mainly from OFFLINE channels: physical stores, distributors, direct sales — NOT online platforms
- Organisations that sell ONLY their own products via website/app = ENTERPRISE (not Consumer Portal)
- Examples: tejasnetworks.com (telecom hardware), wforwoman.com (fashion retail), wildcraft.com (outdoor gear)
- Key test: Is the website primarily a product catalogue / brand site for their own products? → Enterprise

ISV (Independent Software Vendor):
- Owns and develops its OWN software product or platform
- Provides software solutions to businesses or individual users
- Revenue through subscriptions, licensing, or trial-to-paid models
- MUST be independent — not acquired by another organisation
- Core business = software product sales, NOT services
- Examples: Freshworks (CRM software), Zoho (business apps), Postman (API platform)
- Key test: Do they primarily SELL software they BUILT? → ISV

CONSUMER PORTAL:
- ROI primarily dependent on online platforms
- Operates as a MARKETPLACE connecting buyers and sellers
- Revenue from online transactions, commissions, advertisements, or platform usage
- If an organisation ONLY sells its own products through website/app → ENTERPRISE, NOT Consumer Portal
- Examples: Amazon (marketplace), OLX (classifieds), MakeMyTrip (travel marketplace)
- Key test: Do they connect third-party buyers and sellers? → Consumer Portal
- TripJack = Consumer Portal (OTA marketplace connecting travellers with airlines/hotels)

AGENCY / SERVICE COMPANY:
- Primarily provides IT SERVICES: IT consulting, application development, website development, digital transformation
- Does NOT own a proprietary software product as primary offering
- Any NON-IT service organisation → ENTERPRISE, not Agency/Service Company
- Examples: Wipro, Infosys (IT services), ThoughtWorks (consulting)

PE / VC FIRMS:
- Invests capital in businesses — does NOT sell products or services
- PE: invests in mature/established companies, acquires controlling/significant stakes, long-term value creation
- VC: invests in early-stage/growth startups, minority stakes, focuses on innovation and rapid growth
- Examples: Sequoia Capital, SoftBank Vision Fund, Accel

════════════════════════════════════════════
BUSINESS TYPE
════════════════════════════════════════════
B2B: Sells to other businesses. Large deal sizes, longer sales cycles, relationship-driven. Examples: Salesforce, SAP, AWS
B2C: Sells directly to individual consumers. High volume, marketing-driven. Examples: Amazon, Netflix, Uber
B2B and B2C: Serves both segments. Examples: Microsoft (Office 365 + Xbox), Google (Workspace + Search)

════════════════════════════════════════════
ACCOUNT SIZE — by employee count
════════════════════════════════════════════
StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)

════════════════════════════════════════════
INDUSTRIES & SUB-INDUSTRIES — use exact names
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

════════════════════════════════════════════
REGIONS
════════════════════════════════════════════
North America | EMEA | APAC | LATAM | India

════════════════════════════════════════════
CLOUD PLATFORM CLASSIFICATION
════════════════════════════════════════════
- Single cloud: AWS | Azure | GCP | Oracle Cloud | IBM Cloud | Alibaba Cloud | DigitalOcean | Cloudflare | Vercel | Netlify | Heroku | On-premise
- Multi-cloud: use exact pattern → Multi-cloud (AWS, GCP) or Multi-cloud (AWS, Azure, GCP)
- Infer from: company type, region, tech stack, known partnerships
  - Indian startups/scaleups → usually AWS or GCP
  - Travel portals → usually AWS
  - Microsoft-stack companies → Azure
  - Chinese companies → Alibaba Cloud
  - Enterprise on-premise → On-premise
- Only use Unknown if absolutely no signal exists

════════════════════════════════════════════
RESEARCH & INFERENCE RULES — CRITICAL
════════════════════════════════════════════
Use ALL your training knowledge. Never say Unknown when reasonable inference is possible.

LOCATION:
- Infer country from domain TLD: .in=India, .uk=UK, .au=Australia, .de=Germany, .sg=Singapore, .ae=UAE
- For Indian companies: default to India, use known cities (Bangalore, Mumbai, Gurugram, Hyderabad, Pune, Chennai, Delhi)
- For travel/fintech/edtech Indian startups: likely Bangalore or Gurugram
- State from city: Bangalore=Karnataka, Mumbai=Maharashtra, Gurugram=Haryana, Hyderabad=Telangana, Pune=Maharashtra, Chennai=Tamil Nadu, Delhi=Delhi

TIMEZONE:
- India → IST / UTC+5:30
- UK/Ireland → GMT / UTC+0
- Germany/France/Netherlands → CET / UTC+1
- UAE → GST / UTC+4
- Singapore → SGT / UTC+8
- Australia Sydney → AEST / UTC+10
- US West Coast → PST / UTC-8
- US East Coast → EST / UTC-5

LINKEDIN URL:
- Always construct: https://www.linkedin.com/company/[slug]
- Slug = company name lowercased, spaces replaced with hyphens
- TripJack → https://www.linkedin.com/company/tripjack
- MakeMyTrip → https://www.linkedin.com/company/makemytrip
- Freshworks → https://www.linkedin.com/company/freshworks

EMPLOYEE COUNT — estimate from signals:
- Well-funded startup (Series A/B) → 50-500
- Travel OTA in India (TripJack, Yatra) → 200-1000
- Large Indian IT firm → 10000+
- SaaS startup → 50-500
- Listed company with revenue >$100M → 1000+

REVENUE — estimate from stage:
- Early startup → 1-10 USD M
- Series B/C funded → 10-100 USD M
- Mid-market → 50-500 USD M
- Large enterprise → 500+ USD M
- Indian travel OTA → 10-100 USD M

ENGINEERING & IT — infer from company type:
- Travel portals → React/Angular, Node.js/Python, Java microservices, REST APIs, mobile apps (iOS/Android)
- Fintech → Java/Python/Go, Spring Boot, microservices, PostgreSQL/MySQL
- SaaS → React, Node.js/Python/Ruby, PostgreSQL, Redis, REST/GraphQL
- E-commerce → React/Next.js, Node.js, Python, MySQL/MongoDB
- IT Services → Java, .NET, Python, varied per project

DEVOPS — infer from company type and size:
- Modern startup → GitHub Actions, Docker, Kubernetes, CI/CD pipelines
- Mid-size → Jenkins or GitHub Actions, Docker, Kubernetes, Terraform
- Enterprise → Jenkins, Ansible, Terraform, Kubernetes, on-premise or hybrid

════════════════════════════════════════════
OUTPUT — return ONLY this JSON, all 20 keys required
════════════════════════════════════════════
{
  "accountName": "Official company name",
  "website": "domain as provided",
  "draInsights": "2-3 sentences: what the company does, business model, key products/services, market position and target customers",
  "engineeringIT": "Tech stack: languages, frameworks, databases, APIs. Infer from company type if not known directly.",
  "cloudPlatform": "Cloud/hosting platform. Single name OR Multi-cloud (X, Y) pattern. Infer from region and company type.",
  "devOps": "DevOps tools and CI/CD practices. Infer from company size and type.",
  "employeeCount": "Estimated number or range e.g. 500 or 200-500. Use signals from funding, revenue, market presence.",
  "accountTypeBySize": "Exactly one of: StartUp (<50) | Small (50-200) | Medium (200-500) | Large (500-1000) | X-Large (1000-5000) | XX-Large (5000+)",
  "accountType": "Exactly one of: Enterprise | ISV | Consumer Portal | Agency/Service Company | PE/VC Firms",
  "accountTypeReason": "1-2 sentences explaining WHY this account type. Cite specific evidence: product/platform name for ISV, marketplace nature for Consumer Portal, offline revenue channels for Enterprise, IT services for Agency, portfolio investing for PE/VC.",
  "accountLinkedIn": "Full URL: https://www.linkedin.com/company/[slug]. Always construct this — do not leave empty.",
  "businessType": "Exactly one of: B2B | B2C | B2B and B2C",
  "industry": "Exactly one industry from the taxonomy above",
  "subIndustry": "Exactly one matching sub-industry",
  "revenueUSD": "Estimated annual revenue in USD millions e.g. 50 or 10-50. Use company stage signals.",
  "billingCity": "HQ city. Infer from domain, company context, or known HQ location.",
  "billingState": "HQ state/province. Derive from city.",
  "billingCountry": "HQ country. Infer from TLD, name, or context — almost always determinable.",
  "region": "Exactly one of: North America | EMEA | APAC | LATAM | India",
  "timeZone": "HQ timezone derived from country/city e.g. IST / UTC+5:30"
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

    // ── 4. Call Groq ────────────────────────────────────────
    const groqKey = Deno.env.get("GROQ_API_KEY");
    if (!groqKey) {
      return new Response(JSON.stringify({ error: "API key not configured. Contact your admin." }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

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
          { role: "user", content: `Research this company thoroughly using all your knowledge and return the complete 20-field JSON profile.\n\nWebsite: ${website}\n\nIMPORTANT: Use confident inference — do not return Unknown for fields you can reasonably determine from the company name, domain, industry, or region. For Indian companies always provide city, state, country=India, region=India, timezone=IST/UTC+5:30.` }
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

    // ── 6. Return ───────────────────────────────────────────
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